import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";
const crons=cronJobs();
crons.interval("Enroll approved booking reminders",{hours:1},internal.bookingReminders.sweep,{});
// Cheap when nothing changed (one document read); the open overview page
// requests fresher counts itself. See convex/bookingOverviewCache.ts.
crons.interval("Refresh booking overview counts",{minutes:10},internal.bookingOverviewCache.refresh,{});
export default crons;
