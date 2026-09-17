// Dependency-free handler harness for Node >=22.18. External services are mocked;
// these checks complement (not replace) the normal typecheck and Vitest suite.
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const definitions = 'export const action=x=>x, internalAction=x=>x, mutation=x=>x, internalMutation=x=>x, query=x=>x, internalQuery=x=>x;';
const modules = {
  'convex/values': 'export class ConvexError extends Error { constructor(data) { super(data.message); this.data=data; } } export const v = new Proxy({}, { get:()=>()=>({}) });',
  'convex/server': 'export const paginationOptsValidator = {};',
  'luxon': 'export const DateTime = new Proxy({}, {get:()=>()=>{throw new Error("Unexpected Luxon call in dependency-free test")}});',
  server: definitions,
  api: 'const group=new Proxy({}, {get:(_,key)=>String(key)}); export const internal=new Proxy({}, {get:()=>group});',
  auth: 'export const requireCapability=async()=>({clerkUserId:"admin"}); export const requireHeadAdmin=requireCapability;',
  actionAuth: 'export const requireActionCapability=async()=>({clerkUserId:"admin"}); export const requireActionHeadAdmin=requireActionCapability;',
  schema: 'export const calendarEventRefValidator={}, jotformResponseValidator={}, recurrenceFrequencyValidator={};',
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
    return next(url,context);
  },
});
