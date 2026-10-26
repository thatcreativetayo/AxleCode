"use client";

import { ArrowUpRight, Check } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { RevealGroup, RevealItem } from "@/components/fx/reveal";

const PLANS = [
  {
    name: "Free",
    price: "$0",
    unit: "forever",
    tagline: "Your local workspace, free to keep.",
    badge: "Available now",
    cta: "Get Axle",
    highlight: false,
    note: "Model usage billed by your provider.",
    features: [
      "Local projects, terminal, and Git tools",
      "Bring your own model keys or local models",
      "Google Gemma 4, Meta Muse Glimmer, and Nemotron 3.5 Lightning",
      "100 Axle credits every day",
    ],
  },
  {
    name: "Pro",
    price: "$20",
    unit: "month",
    tagline: "For individual work that should not wait.",
    badge: "Most popular",
    cta: "Get Pro",
    highlight: true,
    note: "Billed monthly in the app.",
    features: [
      "Everything in Free",
      "GLM 5.3, GLM 5.3 Flash, and Nemotron 3 Super",
      "2,000 Axle credits every month",
      "Up to 50 scheduled tasks",
      "Model-assisted pull-request reviews",
      "Cloud schedules that run on an Axle cloud runner",
    ],
  },
  {
    name: "Pro+",
    price: "$60",
    unit: "month",
    tagline: "Heavier work, longer runs, more of everything.",
    badge: "",
    cta: "Get Pro+",
    highlight: false,
    note: "Billed monthly in the app.",
    features: [
      "Everything in Pro",
      "4,000 Axle credits every month",
      "Up to 100 scheduled tasks",
      "More concurrent cloud jobs",
    ],
  },
  {
    name: "Ultra",
    price: "$200",
    unit: "month",
    tagline: "The whole engine, with the limits taken off.",
    badge: "",
    cta: "Get Ultra",
    highlight: false,
    note: "Billed monthly in the app.",
    features: [
      "Everything in Pro+",
      "10,000 Axle credits every month",
      "Up to 200 scheduled tasks",
      "The highest cloud-job concurrency",
    ],
  },
] as const;

export function PricingCards() {
  return (
    <RevealGroup className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {PLANS.map((plan) => (
        <RevealItem key={plan.name} className="h-full">
          <div
            className={cn(
              "hairline flex h-full flex-col rounded-[24px] p-6 sm:p-7",
              plan.highlight
                ? "bg-[#161616] ring-1 ring-white/15"
                : "bg-[#101010]",
            )}
          >
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-xl tracking-tight">{plan.name}</h3>
              {plan.badge ? (
                <span
                  className={cn(
                    "shrink-0 rounded-full border px-2.5 py-1 font-mono text-[10px]",
                    plan.highlight
                      ? "border-white/25 text-paper"
                      : "border-white/15 text-paper",
                  )}
                >
                  {plan.badge}
                </span>
              ) : null}
            </div>
            <p className="mt-3 min-h-10 text-sm text-mute">{plan.tagline}</p>
            <div className="mt-8 flex min-h-[61px] items-baseline gap-2">
              <span className="text-[54px] leading-none tracking-[-0.06em]">
                {plan.price}
              </span>
              <span className="text-sm text-mute">/ {plan.unit}</span>
            </div>
            <p className="mt-4 min-h-8 text-xs text-mute">{plan.note}</p>
            <Button
              href="/download"
              variant={plan.highlight ? "primary" : "secondary"}
              className="mt-7 w-full"
            >
              {plan.cta} <ArrowUpRight size={16} />
            </Button>
            <ul className="mt-8 space-y-4 border-t border-white/10 pt-7">
              {plan.features.map((feature) => (
                <li
                  key={feature}
                  className="flex items-start gap-3 text-[13px] leading-6 text-mute"
                >
                  <Check
                    size={15}
                    className="mt-1 shrink-0 text-paper"
                    aria-hidden="true"
                  />
                  {feature}
                </li>
              ))}
            </ul>
          </div>
        </RevealItem>
      ))}
    </RevealGroup>
  );
}
