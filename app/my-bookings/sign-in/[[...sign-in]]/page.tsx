import { SignIn } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import Link from "next/link";
export default async function SubmitterSignIn() {
  const {userId}=await auth();
  if(userId)redirect("/my-bookings");
  return <main className="page"><Link href="/">← RoomOps home</Link><h1>Find your bookings</h1><p>Sign in with the email used on your booking form. Your email must be verified. No administrator approval is required.</p><SignIn routing="path" path="/my-bookings/sign-in" signUpUrl="/my-bookings/sign-up" forceRedirectUrl="/my-bookings" signUpForceRedirectUrl="/my-bookings"/></main>;
}
