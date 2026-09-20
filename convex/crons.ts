import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";
const crons=cronJobs();
crons.interval("Enroll approved booking reminders",{hours:1},internal.bookingReminders.sweep,{});
export default crons;
