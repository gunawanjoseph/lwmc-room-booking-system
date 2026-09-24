import Link from "next/link";
import { SignIn } from "@clerk/nextjs";
import { ChurchLockup } from "@/components/brand";

export default function SignInPage() {
  return (
    <main className="auth-page">
      <section className="auth-intro">
        <div className="auth-brand">
          <ChurchLockup tone="white" width={240} />
          <span>RoomOps · Facilities booking</span>
        </div>
        <div>
          <span className="eyebrow">ADMIN WORKSPACE</span>
          <h1>Welcome back.</h1>
          <p>
            Sign in to review room requests, manage access, or work
            with the booking data table.
          </p>
        </div>
        <p className="auth-footnote">
          Access is granted only after Head Administrator approval.
        </p>
      </section>
      <section className="auth-panel">
        <div className="auth-card">
          <SignIn
            routing="path"
            path="/sign-in"
            signUpUrl="/sign-up"
            fallbackRedirectUrl="/home"
          />
          <div className="auth-register">
            <span>New administrator?</span>
            <Link href="/sign-up">Create an account</Link>
          </div>
        </div>
      </section>
    </main>
  );
}
