"use client";
import {useEffect,useRef,useState} from "react";
import Link from "next/link";
import {usePathname} from "next/navigation";
import {AnimatePresence,motion,useReducedMotion} from "motion/react";
import {Menu,X,ArrowUpRight} from "lucide-react";
import {NAV_LINKS} from "@/lib/nav";
import {EASE} from "@/lib/motion";
import {Logo,LogoMark} from "./logo";
export function Navbar(){
 const [scrolled,setScrolled]=useState(false);
 const [open,setOpen]=useState(false);
 const path=usePathname();const reduce=useReducedMotion();
 const menuRef=useRef<HTMLDivElement>(null);const triggerRef=useRef<HTMLButtonElement>(null);
 useEffect(()=>{const scroll=()=>setScrolled(window.scrollY>25);scroll();window.addEventListener("scroll",scroll,{passive:true});return()=>window.removeEventListener("scroll",scroll);},[]);
 useEffect(()=>{
  if(!open)return;
  const previous=document.body.style.overflow;document.body.style.overflow="hidden";
  const links=()=>menuRef.current?.querySelectorAll<HTMLElement>("a, button");
  links()?.[0]?.focus();
  const key=(e:KeyboardEvent)=>{
   if(e.key==="Escape"){setOpen(false);triggerRef.current?.focus();}
   if(e.key==="Tab"){const items=Array.from(links()??[]);const first=items[0];const last=items.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();triggerRef.current?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();triggerRef.current?.focus();}else if(e.shiftKey&&document.activeElement===triggerRef.current){e.preventDefault();last?.focus();}}
  };
  document.addEventListener("keydown",key);
  const wide=window.matchMedia("(min-width: 1200px)");const resize=()=>{if(wide.matches)setOpen(false);};wide.addEventListener("change",resize);
  return()=>{document.body.style.overflow=previous;document.removeEventListener("keydown",key);wide.removeEventListener("change",resize);};
 },[open]);
 return <header className={"site-header "+(scrolled?"is-scrolled":"")}><div className="site-nav">
  <Link href="/" aria-label="Axle home" onClick={()=>setOpen(false)} className="nav-logo"><Logo/></Link>
  <nav className="desktop-nav" aria-label="Main"><ul>{NAV_LINKS.map(link=><li key={link.href}><Link aria-current={path===link.href?"page":undefined} href={link.href}>{link.label}</Link></li>)}</ul></nav>
  <div className="nav-actions"><Link href="/signin" className="signin-link">Sign in</Link><Link href="/download" className="nav-download"><LogoMark className="h-[16px] w-[14px]"/><span>Get Axle</span><ArrowUpRight size={14} className="nav-download-arrow"/></Link><button className="menu-toggle" ref={triggerRef} onClick={()=>setOpen(!open)} aria-expanded={open} aria-controls="mobile-menu" aria-label={open?"Close menu":"Open menu"}>{open?<X size={20}/>:<Menu size={20}/>}</button></div>
 </div><AnimatePresence>{open&&<motion.div className="mobile-menu" id="mobile-menu" ref={menuRef} initial={{opacity:0,y:reduce?0:-8}} animate={{opacity:1,y:0}} exit={{opacity:0,y:reduce?0:-8}} transition={{duration:.4,ease:EASE}}><nav aria-label="Mobile"><span className="mono-label">A workspace of possibilities</span>{NAV_LINKS.map((link,i)=><Link key={link.href} href={link.href} onClick={()=>setOpen(false)} aria-current={path===link.href?"page":undefined}><span className="font-mono text-xs text-mute-dim">0{i+1}</span>{link.label}<ArrowUpRight size={17}/></Link>)}<Link href="/signin" onClick={()=>setOpen(false)}>Sign in<ArrowUpRight size={17}/></Link></nav></motion.div>}</AnimatePresence></header>;
}
