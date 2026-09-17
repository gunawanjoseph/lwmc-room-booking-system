import { publicMeetings } from "./lib/publicBookings";
import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { query, internalQuery } from "./_generated/server";
import { submitterMeetings } from "./lib/submitterBookings";

export const list = query({
  args:{email:v.string(),paginationOpts:paginationOptsValidator},
  handler:async(ctx,args)=>{
    const identity=await ctx.auth.getUserIdentity();
    const email=args.email.trim().toLowerCase();
    if(!identity || identity.emailVerified!==true || typeof identity.email!=="string" || identity.email.trim().toLowerCase()!==email) {
      throw new ConvexError("Sign in with the verified email used for your booking. You can only view your own bookings.");
    }
    const result=await ctx.db.query("bookings").withIndex("by_requester_email",q=>q.eq("requesterEmail",email)).order("desc").paginate(args.paginationOpts);
    return {...result,page:result.page.map(booking=>({id:booking._id,meetings:submitterMeetings(booking)}))};
  },
});
export const viewer = query({args:{},handler:async(ctx)=>{
  const identity=await ctx.auth.getUserIdentity();
  return {email:identity?.emailVerified===true && typeof identity.email==="string"?identity.email.trim().toLowerCase():null,timezone:process.env.BOOKING_TIME_ZONE||"Asia/Singapore"};
}});
// Only trusted email workers can look up a recipient without a signed-in session.
export const emailPage=internalQuery({args:{email:v.string(),paginationOpts:paginationOptsValidator},handler:async(ctx,args)=>{
  const result=await ctx.db.query("bookings").withIndex("by_requester_email",q=>q.eq("requesterEmail",args.email.trim().toLowerCase())).paginate(args.paginationOpts);
  return {...result,page:result.page.flatMap(submitterMeetings),timezone:process.env.BOOKING_TIME_ZONE||"Asia/Singapore"};
}});

// Public availability view. Index each visible status separately; never fetch rejected rows.
export const publicList=query({
  args:{status:v.union(v.literal("approved"),v.literal("pending")),paginationOpts:paginationOptsValidator},
  handler:async(ctx,args)=>{
    if(args.status!=="approved"&&args.status!=="pending")throw new ConvexError("Invalid public booking status.");
    const result=await ctx.db.query("bookings").withIndex("by_status",q=>q.eq("status",args.status)).order("desc").paginate(args.paginationOpts);
    return {...result,page:result.page.map(booking=>({id:booking._id,meetings:publicMeetings(booking)}))};
  },
});
export const publicSettings=query({args:{},handler:async()=>({timezone:process.env.BOOKING_TIME_ZONE||"Asia/Singapore"})});
