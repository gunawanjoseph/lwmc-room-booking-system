import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";
const crons=cronJobs();
crons.interval("Enroll approved booking reminders",{hours:1},internal.bookingReminders.sweep,{});
crons.interval("Refresh booking overview counts",{minutes:2},internal.bookingOverviewCache.refresh,{});
export default crons;
