import { SignUp } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import Link from "next/link";
export default async function SubmitterSignUp() {
  const {userId}=await auth();
  if(userId)redirect("/my-bookings");
  return <main className="page"><Link href="/my-bookings/sign-in">← Sign in</Link><h1>Verify your booking email</h1><p>Create your sign-in using the email entered on your booking form. This lets you view your own bookings and does not request administrator access.</p><SignUp routing="path" path="/my-bookings/sign-up" signInUrl="/my-bookings/sign-in" forceRedirectUrl="/my-bookings" signInForceRedirectUrl="/my-bookings"/></main>;
}
