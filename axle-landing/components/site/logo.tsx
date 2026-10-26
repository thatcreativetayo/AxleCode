import { cn } from "@/lib/cn";
export function LogoMark({ className }: { className?: string }) {
 return <svg viewBox="0 0 32 36" className={cn("h-8 w-7",className)} aria-hidden="true" focusable="false"><path fill="currentColor" d="m12.1 4.7-4.5 8.8c-1 1.9.8 3.5 2.7 2.6l12-5.8-2.9-5.6c-1.5-3-5.8-3-7.3 0ZM7.1 21.3 23.9 13l7.2 14.1c2.3 4.5-2.7 9-6.9 6.2l-7.1-4.7-8.3 4.8c-4.4 2.5-9.1-2.1-6.6-6.5l2.3-4.1c.6-.8 1.4-1.2 2.6-1.5Z"/></svg>;
}
export function Logo({className,showWordmark=true}:{className?:string;showWordmark?:boolean}) {
 return <span className={cn("inline-flex items-center gap-2.5 text-paper",className)}><LogoMark/>{showWordmark&&<span className="text-[20px] font-semibold tracking-[-0.8px]">Axle</span>}</span>;
}
export function AppleIcon({className="h-5 w-5"}:{className?:string}) {
 return <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true"><path d="M17.2 12.3c0-2.1 1.7-3.1 1.8-3.2-1-1.4-2.5-1.6-3-1.7-1.3-.1-2.5.8-3.1.8s-1.6-.8-2.7-.7c-1.4 0-2.7.8-3.4 2-1.4 2.5-.4 6.3 1 8.3.7 1 1.5 2.1 2.5 2 1 0 1.4-.6 2.7-.6 1.2 0 1.6.6 2.7.6s1.7-1 2.4-2c.8-1.2 1.1-2.3 1.1-2.4-.1 0-2-.8-2-3.1ZM15.1 6.1c.6-.7 1-1.7.9-2.7-.9 0-2 .6-2.6 1.3-.6.6-1.1 1.6-1 2.6 1 .1 2-.5 2.7-1.2Z"/></svg>;
}
