import type { Metadata } from "next";
import { LegalPage, type LegalSection } from "@/components/site/legal-page";
import { SITE } from "@/lib/site";

export const metadata: Metadata = {
  title: "Security",
  description: "Practical security guidance for desktop releases, agent permissions, provider credentials, and reporting issues.",
};

const sections: LegalSection[] = [
  {
    id: "releases",
    heading: "Start with the project’s releases",
    paragraphs: [
      "Use the project’s download service or published GitHub releases. Match the installer to your operating system and architecture, and keep the app and your operating system up to date.",
      "Review the release information for the version you install. Desktop builds currently use the Axle project name.",
    ],
    links: [{ label: "Download the desktop app", href: "/download" }, { label: "GitHub releases", href: SITE.releases }],
  },
  {
    id: "permissions",
    heading: "Review agent and integration access",
    paragraphs: [
      "Agents can work with files and run tools according to the capabilities and permissions available in their environment. Review proposed actions and code changes before relying on the result.",
      "Grant connected apps the access they need for your task. Be especially careful with production environments, organization accounts, and services that can publish or modify shared information.",
    ],
  },
  {
    id: "credentials",
    heading: "Protect your credentials and environments",
    paragraphs: [
      "Keep provider API keys and other secrets out of repositories, prompts, screenshots, and shared logs. Revoke or rotate a credential with its provider if it is exposed.",
      "Use the security controls available on your device and provider accounts. Your selected models, connected services, and remote environments each have their own security boundaries.",
    ],
    links: [{ label: "Model configuration", href: "/docs#models" }, { label: "Privacy & data", href: "/legal/privacy" }],
  },
  {
    id: "reporting",
    heading: "Report a problem",
    paragraphs: [
      "Check the repository’s Security tab for the current vulnerability-reporting options before sharing sensitive details. Keep private data and credentials out of public reports.",
      "For a non-sensitive bug, include the app version, operating system, steps to reproduce, and a description of the expected result in a GitHub issue.",
    ],
    links: [{ label: "Repository security", href: SITE.github + "/security" }, { label: "Report a non-sensitive bug", href: SITE.issues }],
  },
];

export default function SecurityPage() {
  return <LegalPage eyebrow="The details" title="Security, in practice." updated="October 13, 2026" intro="A workspace connects powerful tools. Here are practical ways to manage that access and protect the projects you work on." sections={sections} />;
}
