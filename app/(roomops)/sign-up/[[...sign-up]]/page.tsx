import Link from "next/link";
import { SignUp } from "@clerk/nextjs";
import { ChurchLockup } from "@/components/brand";

export default function SignUpPage() {
  return (
    <main className="auth-page">
      <section className="auth-intro">
        <div className="auth-brand">
          <ChurchLockup tone="white" width={240} />
          <span>RoomOps · Facilities booking</span>
        </div>
        <div>
          <span className="eyebrow">REQUEST ACCESS</span>
          <h1>Create your administrator identity.</h1>
          <p>
            Verify your email, then submit a short access request for
            the Head Administrator to review.
          </p>
        </div>
        <p className="auth-footnote">
          Already registered? <Link href="/sign-in">Sign in</Link>
        </p>
      </section>
      <section className="auth-panel">
        <div className="auth-card">
          <SignUp
            routing="path"
            path="/sign-up"
            signInUrl="/sign-in"
            fallbackRedirectUrl="/register"
          />
        </div>
      </section>
    </main>
  );
}
