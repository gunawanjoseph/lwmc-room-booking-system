"use client";
import { useAction } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { PublicMeeting } from "@/convex/lib/publicBookings";
type Snapshot={rows:PublicMeeting[];fetchedAt:number|null;error:string|null;refreshing:boolean};
const CACHE_TTL_MS=15*60*1000;
export function useGoogleSchedule(month:string){
  const read=useAction(api.publicCalendar.read);
  const [state,setState]=useState<{month:string;snapshot:Snapshot|null;loading:boolean}>({month:'',snapshot:null,loading:true});
  const [revision,setRevision]=useState(0);
  const shown=useRef<{month:string;snapshot:Snapshot|null}>({month:'',snapshot:null});
  useEffect(()=>{
    let active=true,busy=false;let timer:ReturnType<typeof setTimeout>|undefined;
    // The copy already on screen. Sending its fetchedAt lets the server
    // answer "unchanged" without re-reading the whole schedule.
    let current=shown.current.month===month?shown.current.snapshot:null;
    function schedule(delay:number){
      clearTimeout(timer);
      // Background tabs don't poll; they catch up when shown again.
      timer=document.visibilityState==='visible'?setTimeout(refresh,delay):undefined;
    }
    function nextDelay(snapshot:Snapshot){
      if(snapshot.refreshing)return 4000;
      return snapshot.fetchedAt?Math.max(1000,CACHE_TTL_MS-(Date.now()-snapshot.fetchedAt)):CACHE_TTL_MS;
    }
    async function refresh(){
      clearTimeout(timer);timer=undefined;busy=true;
      if(!current)setState(old=>({...old,loading:true}));
      try{
        const result=await read({month,since:current?.fetchedAt??undefined});
        if(!active)return;
        const snapshot:Snapshot=result.unchanged&&current
          ?{...current,error:result.error,refreshing:result.refreshing}
          :{rows:result.rows,fetchedAt:result.fetchedAt,error:result.error,refreshing:result.refreshing};
        current=snapshot;shown.current={month,snapshot};busy=false;
        setState({month,snapshot,loading:snapshot.refreshing&&!snapshot.fetchedAt});
        schedule(nextDelay(snapshot));
      }catch{
        if(!active)return;
        const snapshot:Snapshot={rows:current?.rows??[],fetchedAt:current?.fetchedAt??null,error:'Unable to load Google Calendar. Please try again.',refreshing:false};
        current=snapshot;shown.current={month,snapshot};busy=false;
        setState({month,snapshot,loading:false});
        schedule(CACHE_TTL_MS);
      }
    }
    function onVisibility(){
      if(document.visibilityState!=='visible'){clearTimeout(timer);timer=undefined;return;}
      if(timer===undefined&&!busy)schedule(current?nextDelay(current):0);
    }
    void refresh();
    document.addEventListener('visibilitychange',onVisibility);
    return()=>{active=false;clearTimeout(timer);document.removeEventListener('visibilitychange',onVisibility);};
  },[month,read,revision]);
  return {snapshot:state.month===month?state.snapshot:null,loading:state.loading||state.month!==month,refresh:()=>setRevision(value=>value+1)};
}
