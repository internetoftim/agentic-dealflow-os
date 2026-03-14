export type DealSource = "deal-desk" | "personal-gmail" | "manual" | "docusend";

export interface Deal {
  id: string;
  name: string;
  stage: string;
  sector: string;
  source: DealSource;
  autoIngested: boolean;
  status: "inbox" | "extracting" | "analysis" | "memo-ready";
  deckSize?: string;
  compressedSize?: string;
  pages?: number;
  website?: string;
  websiteSearching?: boolean;
}

export const mockDeals: Deal[] = [
  { id: "1", name: "NovaStar AI", stage: "Series A", sector: "AI/ML", source: "deal-desk", autoIngested: true, status: "memo-ready", deckSize: "45MB", compressedSize: "3.1MB", pages: 24, website: "https://novastar.ai" },
  { id: "2", name: "GreenLeaf Bio", stage: "Seed", sector: "BioTech", source: "personal-gmail", autoIngested: true, status: "analysis", deckSize: "32MB", compressedSize: "2.8MB", pages: 18, website: "https://greenleafbio.com" },
  { id: "3", name: "QuantumEdge", stage: "Series B", sector: "Quantum Computing", source: "manual", autoIngested: false, status: "extracting", deckSize: "58MB", compressedSize: undefined, pages: undefined },
  { id: "4", name: "UrbanMobility", stage: "Pre-Seed", sector: "Mobility", source: "docusend", autoIngested: true, status: "inbox", deckSize: undefined },
  { id: "5", name: "DataHive", stage: "Series A", sector: "Data Infrastructure", source: "deal-desk", autoIngested: true, status: "inbox", deckSize: undefined },
  { id: "6", name: "ClearPath Health", stage: "Seed", sector: "HealthTech", source: "personal-gmail", autoIngested: false, status: "analysis", deckSize: "28MB", compressedSize: "1.9MB", pages: 15, website: undefined, websiteSearching: true },
  { id: "7", name: "SynthWave Audio", stage: "Series A", sector: "Consumer", source: "deal-desk", autoIngested: true, status: "memo-ready", deckSize: "41MB", compressedSize: "2.7MB", pages: 20, website: "https://synthwave.audio" },
  { id: "8", name: "Orbital Labs", stage: "Seed", sector: "SpaceTech", source: "manual", autoIngested: false, status: "extracting", deckSize: "67MB" },
];

export const sourceConfig: Record<DealSource, { label: string; colorClass: string; bgClass: string }> = {
  "deal-desk": { label: "Deal Desk", colorClass: "text-badge-purple", bgClass: "bg-badge-purple-muted" },
  "personal-gmail": { label: "Personal Gmail", colorClass: "text-badge-blue", bgClass: "bg-badge-blue-muted" },
  "manual": { label: "Manual Upload", colorClass: "text-badge-amber", bgClass: "bg-badge-amber-muted" },
  "docusend": { label: "DocSend", colorClass: "text-badge-green", bgClass: "bg-badge-green-muted" },
};
