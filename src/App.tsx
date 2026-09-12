import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "next-themes";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/contexts/AuthContext";
import { AppLayout } from "@/components/AppLayout";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import KanbanPipeline from "@/pages/KanbanPipeline";
import DealWorkspace from "@/pages/DealWorkspace";
import DataRoom from "@/pages/DataRoom";
import SettingsPage from "@/pages/SettingsPage";
import IntakePage from "@/pages/IntakePage";
import LoginPage from "@/pages/LoginPage";
import NotFound from "@/pages/NotFound";
import IngestRelay from "@/pages/IngestRelay";
import PublicIntake from "@/pages/PublicIntake";
import AcceptShare from "@/pages/AcceptShare";
import McpAuthorize from "@/pages/McpAuthorize";
import ConvertLink from "@/pages/ConvertLink";
import ConversionDashboard from "@/pages/ConversionDashboard";
import MyConversions from "@/pages/MyConversions";


// Shared across every tab: keep data fresh via realtime + targeted polling,
// not via refetch-on-focus stampedes; back off instead of hammering a busy backend.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      refetchIntervalInBackground: false,
      retry: 2,
      retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 8_000),
    },
  },
});

const App = () => (
  <QueryClientProvider client={queryClient}>
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false} disableTransitionOnChange>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/intake/:userId" element={<PublicIntake />} />
            <Route path="/convert" element={<ConvertLink />} />
            <Route path="/converted/:token" element={<ConversionDashboard />} />
            <Route path="/my-decks" element={<MyConversions />} />

            <Route path="/share/:token" element={<AcceptShare />} />
            <Route path="/mcp/authorize" element={<McpAuthorize />} />
            <Route path="/ingest-relay" element={<ProtectedRoute><IngestRelay /></ProtectedRoute>} />
            <Route
              path="/*"
              element={
                <ProtectedRoute>
                  <AppLayout>
                    <Routes>
                      <Route path="/" element={<DealWorkspace />} />
                      <Route path="/pipeline" element={<KanbanPipeline />} />
                      <Route path="/data-room" element={<DataRoom />} />
                      <Route path="/intake" element={<IntakePage />} />
                      <Route path="/settings" element={<SettingsPage />} />
                      <Route path="*" element={<NotFound />} />
                    </Routes>
                  </AppLayout>
                </ProtectedRoute>
              }
            />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
    </ThemeProvider>
  </QueryClientProvider>
);

export default App;
