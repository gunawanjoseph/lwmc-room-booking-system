// Dependency-free handler harness for Node >=22.18. External services are mocked;
// these checks complement (not replace) the normal typecheck and Vitest suite.
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const definitions = 'export const action=x=>x, internalAction=x=>x, mutation=x=>x, internalMutation=x=>x, query=x=>x, internalQuery=x=>x, httpAction=x=>x;';
const modules = {
  'convex/values': 'export class ConvexError extends Error { constructor(data) { super(typeof data === "string" ? data : data.message); this.data=data; } } export const v = new Proxy({}, { get:()=>()=>({}) });',
  'convex/server': 'export const paginationOptsValidator = {}; export const httpRouter=()=>({route:r=>(globalThis.__roomopsRoutes??=[]).push(r)});',
  'luxon': 'export const DateTime = new Proxy({}, {get:()=>()=>{throw new Error("Unexpected Luxon call in dependency-free test")}});',
  server: definitions,
  api: 'const group=new Proxy({}, {get:(_,key)=>String(key)}); export const internal=new Proxy({}, {get:()=>group});',
  auth: `import * as real from ${JSON.stringify(new URL('../convex/lib/auth.ts',import.meta.url).href)};
    export const configuredHeadAdminId=real.configuredHeadAdminId, isConfiguredHeadAdmin=real.isConfiguredHeadAdmin, requireIdentity=real.requireIdentity, requireRegistrationIdentity=real.requireRegistrationIdentity, sessionUser=real.sessionUser, requireActiveUser=real.requireActiveUser;
    import {capabilitiesForRole} from ${JSON.stringify(new URL('../shared/roles.ts',import.meta.url).href)};
    export const normalizeUser=u=>({...u,clerkUserId:u.clerkUserId??u.identitySubject,displayName:u.displayName??u.name??u.email});
    export const effectiveCapabilities=u=>u.status==='active'?capabilitiesForRole(u.role):[];
    export const requireCapability=async(ctx,cap)=>{
      if (globalThis.__roomopsRealAuth) return real.requireCapability(ctx,cap);
      if (!('__roomopsActor' in globalThis)) return {clerkUserId:'admin'};
      const actor=globalThis.__roomopsActor;
      if(!actor||!effectiveCapabilities(actor).includes(cap))throw new Error('Access denied');
      return actor;
    };
    export const requireHeadAdmin=async ctx=>globalThis.__roomopsRealAuth?real.requireHeadAdmin(ctx):requireCapability(ctx);
    export const userBySubject=async(ctx,subject)=>{if(globalThis.__roomopsRealAuth)return real.userBySubject(ctx,subject);const u=await ctx.db.query('users').withIndex('by_clerk_user_id',q=>q.eq('clerkUserId',subject)).unique();return u?normalizeUser(u):null;};`,
  actionAuth: 'export const requireActionCapability=async()=>({clerkUserId:"admin"}); export const requireActionHeadAdmin=requireActionCapability;',
  schema: 'export const calendarEventRefValidator={}, jotformResponseValidator={}, recurrenceFrequencyValidator={}, nonHeadRoleValidator={};',
};
registerHooks({
  resolve(specifier, context, next) {
    let key = specifier;
    if (/\/_generated\/server$/.test(specifier)) key='server';
    if (/\/_generated\/api$/.test(specifier)) key='api';
    if (specifier === './lib/auth') key='auth';
    if (specifier === './lib/actionAuth') key='actionAuth';
    if (specifier === './schema') key='schema';
    if (key in modules) return {url:`roomops-test:${key}`,shortCircuit:true};
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      const url=new URL(specifier,context.parentURL);
      if (!existsSync(fileURLToPath(url)) && existsSync(fileURLToPath(url)+'.ts')) {
        return next(url.href+'.ts',context);
      }
    }
    return next(specifier,context);
  },
  load(url, context, next) {
    if (url.startsWith('roomops-test:')) return {format:'module', source:modules[url.slice(13)],shortCircuit:true};
    if (url.startsWith('file:') && url.endsWith('.ts')) return {
      format:'module', source:stripTypeScriptTypes(readFileSync(new URL(url),'utf8'),{mode:'transform'}),shortCircuit:true,
    };
    return next(url,context);
  },
});
