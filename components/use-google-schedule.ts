"use client";
import { useAction } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { PublicMeeting } from "@/convex/lib/publicBookings";
type Snapshot={rows:PublicMeeting[];fetchedAt:number|null;error:string|null;refreshing:boolean};
const CACHE_TTL_MS=15*60*1000;
export function useGoogleSchedule(month:string){
  const read=useAction(api.publicCalendar.read);
  const [state,setState]=useState<{month:string;snapshot:Snapshot|null;loading:boolean}>({month:'',snapshot:null,loading:true});
  const [revision,setRevision]=useState(0);
  useEffect(()=>{
    let active=true;let timer:ReturnType<typeof setTimeout>;
    async function refresh(){
      setState(old=>({...old,loading:true}));
      try{
        const snapshot=await read({month});
        if(!active)return;
        setState({month,snapshot,loading:snapshot.refreshing&&!snapshot.fetchedAt});
        // Match the server cache lifetime. Polling every minute was forcing a
        // full public-calendar cache read for every open tab and refreshing it
        // again as soon as the old 60-second cache expired.
        const untilNextRefresh=snapshot.fetchedAt
          ?Math.max(1000,CACHE_TTL_MS-(Date.now()-snapshot.fetchedAt))
          :CACHE_TTL_MS;
        timer=setTimeout(refresh,snapshot.refreshing?4000:untilNextRefresh);
      }catch{
        if(!active)return;
        setState(old=>({month,snapshot:{rows:old.month===month?old.snapshot?.rows??[]:[],fetchedAt:old.month===month?old.snapshot?.fetchedAt??null:null,error:'Unable to load Google Calendar. Please try again.',refreshing:false},loading:false}));
        timer=setTimeout(refresh,CACHE_TTL_MS);
      }
    }
    void refresh();
    return()=>{active=false;clearTimeout(timer);};
  },[month,read,revision]);
  return {snapshot:state.month===month?state.snapshot:null,loading:state.loading||state.month!==month,refresh:()=>setRevision(value=>value+1)};
}
