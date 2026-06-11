import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes, Navigate } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { AppLayout } from "@/components/AppLayout";
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

const queryClient = new QueryClient();

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin-slow h-8 w-8 border-2 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/intake/:userId" element={<PublicIntake />} />
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
  </QueryClientProvider>
);

export default App;
