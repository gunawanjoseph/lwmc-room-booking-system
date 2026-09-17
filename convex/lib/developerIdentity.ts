/** One environment-owned developer identity; legacy recipient rows are ignored. */
export function configuredDeveloperEmail(): string | null {
  const email = process.env.DEVELOPER_EMAIL?.trim().toLowerCase() ?? "";
  return email.length <= 254 && /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(email)
    ? email : null;
}

export function isDeveloperEmail(email: string): boolean {
  const configured = configuredDeveloperEmail();
  return configured !== null && email.trim().toLowerCase() === configured;
}

export function isDeveloperIdentity(identity: { email?: unknown; emailVerified?: unknown }): boolean {
  return identity.emailVerified === true && typeof identity.email === "string" && isDeveloperEmail(identity.email);
}
