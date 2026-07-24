import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const http = httpRouter();
const MAX_WEBHOOK_BYTES = 1_000_000;

class PayloadTooLargeError extends Error {}

function jsonResponse(
  body: Record<string, unknown>,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function constantTimeEqual(first: string, second: string): boolean {
  const maxLength = Math.max(first.length, second.length);
  let mismatch = first.length ^ second.length;
  for (let index = 0; index < maxLength; index += 1) {
    mismatch |=
      (first.charCodeAt(index) || 0) ^ (second.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new PayloadTooLargeError();
    }
    chunks.push(value);
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function webhookFields(request: Request): Promise<{
  submissionId: string;
  formId?: string;
}> {
  const contentType = request.headers.get("content-type") ?? "";
  if (
    contentType.includes("multipart/form-data") ||
    contentType.includes("application/x-www-form-urlencoded")
  ) {
    const form = await request.formData();
    return {
      submissionId: String(
        form.get("submissionID") ?? form.get("submissionId") ?? "",
      ).trim(),
      formId: String(
        form.get("formID") ?? form.get("formId") ?? "",
      ).trim() || undefined,
    };
  }
  if (contentType.includes("application/json")) {
    const body = (await request.json()) as Record<string, unknown>;
    return {
      submissionId: String(
        body.submissionID ?? body.submissionId ?? "",
      ).trim(),
      formId:
        String(body.formID ?? body.formId ?? "").trim() || undefined,
    };
  }

  const params = new URLSearchParams(await request.text());
  return {
    submissionId: String(
      params.get("submissionID") ?? params.get("submissionId") ?? "",
    ).trim(),
    formId:
      String(params.get("formID") ?? params.get("formId") ?? "").trim() ||
      undefined,
  };
}

http.route({
  path: "/webhooks/jotform",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const configuredSecret = process.env.JOTFORM_WEBHOOK_SECRET?.trim();
    if (
      !configuredSecret ||
      configuredSecret.length < 32 ||
      configuredSecret.length > 256
    ) {
      return jsonResponse(
        { ok: false, error: "WEBHOOK_NOT_CONFIGURED" },
        503,
      );
    }

    const suppliedSecret = new URL(request.url).searchParams.get(
      "secret",
    );
    if (
      !suppliedSecret ||
      suppliedSecret.length > 256 ||
      !constantTimeEqual(suppliedSecret, configuredSecret)
    ) {
      return jsonResponse({ ok: false, error: "UNAUTHORIZED" }, 401);
    }

    const contentLength = Number(
      request.headers.get("content-length") ?? "0",
    );
    if (
      Number.isFinite(contentLength) &&
      contentLength > MAX_WEBHOOK_BYTES
    ) {
      return jsonResponse({ ok: false, error: "PAYLOAD_TOO_LARGE" }, 413);
    }

    try {
      const body = await readBoundedBody(request, MAX_WEBHOOK_BYTES);
      const parsedRequest = new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body: body.buffer as ArrayBuffer,
      });
      const fields = await webhookFields(parsedRequest);
      if (!/^\d{6,30}$/.test(fields.submissionId)) {
        return jsonResponse(
          { ok: false, error: "SUBMISSION_ID_INVALID" },
          400,
        );
      }
      const expectedFormId = process.env.JOTFORM_FORM_ID?.trim();
      if (!expectedFormId) {
        return jsonResponse(
          { ok: false, error: "FORM_NOT_CONFIGURED" },
          503,
        );
      }
      if (fields.formId && fields.formId !== expectedFormId) {
        return jsonResponse(
          { ok: false, error: "FORM_ID_MISMATCH" },
          400,
        );
      }

      const result = await ctx.runMutation(
        internal.jotform.queueSubmission,
        {
          formId: expectedFormId,
          submissionId: fields.submissionId,
        },
      );
      return jsonResponse({ ok: true, ...result });
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        return jsonResponse(
          { ok: false, error: "PAYLOAD_TOO_LARGE" },
          413,
        );
      }
      return jsonResponse(
        {
          ok: false,
          error:
            error instanceof Error
              ? error.message.slice(0, 200)
              : "WEBHOOK_PROCESSING_ERROR",
        },
        500,
      );
    }
  }),
});

export default http;
