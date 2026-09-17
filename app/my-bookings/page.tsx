import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { MyBookings } from "@/components/my-bookings";
export default async function MyBookingsPage() {
  const {userId}=await auth();
  if(!userId)redirect("/my-bookings/sign-in");
  return <MyBookings />;
}
