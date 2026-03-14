import { FolderOpen, FileText, Download } from "lucide-react";

const files = [
  { name: "2024-01-15 - NovaStar AI - Series A - AI_ML.pdf", size: "3.1 MB", date: "Jan 15, 2024" },
  { name: "2024-01-12 - GreenLeaf Bio - Seed - BioTech.pdf", size: "2.8 MB", date: "Jan 12, 2024" },
  { name: "2024-01-10 - SynthWave Audio - Series A - Consumer.pdf", size: "2.7 MB", date: "Jan 10, 2024" },
  { name: "2024-01-08 - ClearPath Health - Seed - HealthTech.pdf", size: "1.9 MB", date: "Jan 8, 2024" },
];

export default function DataRoom() {
  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-foreground">Data Room</h1>
        <p className="text-sm text-muted-foreground mt-1">Processed decks synced to Google Drive</p>
      </div>
      <div className="rounded-lg border border-border bg-card">
        <div className="grid grid-cols-[1fr_100px_120px_40px] gap-4 px-4 py-2.5 border-b border-border text-[11px] uppercase tracking-wider font-semibold text-muted-foreground">
          <span>Name</span>
          <span>Size</span>
          <span>Date</span>
          <span />
        </div>
        {files.map((file) => (
          <div key={file.name} className="grid grid-cols-[1fr_100px_120px_40px] gap-4 px-4 py-3 border-b border-border last:border-b-0 hover:bg-accent/50 transition-colors group">
            <div className="flex items-center gap-2 min-w-0">
              <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
              <span className="text-sm text-foreground truncate">{file.name}</span>
            </div>
            <span className="text-sm text-muted-foreground">{file.size}</span>
            <span className="text-sm text-muted-foreground">{file.date}</span>
            <button className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground">
              <Download className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
