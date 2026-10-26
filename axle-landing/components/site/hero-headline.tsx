"use client";
import {motion,useReducedMotion} from "motion/react";
import {EASE} from "@/lib/motion";
export function HeroHeadline(){const reduce=useReducedMotion();return <h1 className="hero-headline">{[<>Everything you need to build,</>,<>with the freedom to <strong>build your way.</strong></>].map((line,i)=><span className="headline-mask" key={i}><motion.span initial={{y:reduce?0:"110%",opacity:0}} animate={{y:0,opacity:1}} transition={{duration:.8,delay:i*.1,ease:EASE}}>{line}</motion.span></span>)}</h1>;}
