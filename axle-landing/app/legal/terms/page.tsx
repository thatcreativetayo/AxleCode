import type { Metadata } from "next";
import { LegalPage, type LegalSection } from "@/components/site/legal-page";
import { SITE } from "@/lib/site";

export const metadata: Metadata = {
  title: "Terms & licensing",
  description: "Read about the desktop source license, third-party service terms, and reviewing the work you create.",
};

const sections: LegalSection[] = [
  {
    id: "license",
    heading: "The desktop source license",
    paragraphs: [
      "The desktop source included with this project contains an MIT License. It permits use, copying, modification, and distribution, subject to preserving the required copyright and permission notices.",
      "Consult the LICENSE file and third-party notices shipped with the version you install for the exact terms and copyright attribution. Current desktop releases are published under the Axle project name.",
    ],
    links: [{ label: "MIT License text", href: "https://opensource.org/license/mit" }, { label: "Project source", href: SITE.github }],
  },
  {
    id: "services",
    heading: "Third-party services",
    paragraphs: [
      "Model providers, connected apps, and hosting services can have their own accounts, usage limits, charges, and terms. Review those terms before connecting a service or submitting content.",
      "A software license and a provider subscription cover different things. Check your provider account for inference costs and usage conditions.",
    ],
    links: [{ label: "Model setup", href: "/docs#models" }, { label: "Privacy & data", href: "/legal/privacy" }],
  },
  {
    id: "work",
    heading: "Your projects and generated work",
    paragraphs: [
      "Use repositories, data, and services you are authorized to access. Review the permissions you grant to agents and integrations, especially when they can run commands or change files.",
      "Generated code and suggestions can contain errors. Review changes, run appropriate checks, and assess any third-party licensing requirements before using or distributing the result.",
    ],
  },
  {
    id: "warranty",
    heading: "License notices and warranty",
    paragraphs: [
      "The MIT License provides the software “as is” and includes a warranty disclaimer and limitation of liability. Refer to the actual license text for those provisions.",
      "Keep the license and attribution notices required by the software and its dependencies when redistributing a build or derivative work.",
    ],
    links: [{ label: "Published releases", href: SITE.releases }],
  },
];

export default function TermsPage() {
  return <LegalPage eyebrow="The details" title="Terms & licensing" updated="October 13, 2026" intro="The desktop source license, connected-service terms, and a few practical responsibilities when building with AI." sections={sections} />;
}
