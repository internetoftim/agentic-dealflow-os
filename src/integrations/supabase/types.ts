export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.4"
  }
  public: {
    Tables: {
      capture_jobs: {
        Row: {
          created_at: string
          deal_id: string
          error_message: string | null
          id: string
          status: string
          updated_at: string
          url: string
          user_id: string
        }
        Insert: {
          created_at?: string
          deal_id: string
          error_message?: string | null
          id?: string
          status?: string
          updated_at?: string
          url: string
          user_id: string
        }
        Update: {
          created_at?: string
          deal_id?: string
          error_message?: string | null
          id?: string
          status?: string
          updated_at?: string
          url?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "capture_jobs_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deals"
            referencedColumns: ["id"]
          },
        ]
      }
      deals: {
        Row: {
          ask_amount: string | null
          auto_ingested: boolean
          compressed_size: string | null
          created_at: string
          crunchbase_url: string | null
          deck_size: string | null
          deep_research_status: string
          funding_total: string | null
          gdrive_file_id: string | null
          growth: string | null
          id: string
          last_funding_round: string | null
          linkedin_url: string | null
          memo_draft: string | null
          name: string
          nrr: string | null
          num_employees: string | null
          pages: number | null
          paused_at_step: string | null
          revenue: string | null
          sector: string
          source: string
          stage: string
          status: string
          team_size: string | null
          updated_at: string
          user_id: string
          valuation: string | null
          website: string | null
          website_searching: boolean | null
        }
        Insert: {
          ask_amount?: string | null
          auto_ingested?: boolean
          compressed_size?: string | null
          created_at?: string
          crunchbase_url?: string | null
          deck_size?: string | null
          deep_research_status?: string
          funding_total?: string | null
          gdrive_file_id?: string | null
          growth?: string | null
          id?: string
          last_funding_round?: string | null
          linkedin_url?: string | null
          memo_draft?: string | null
          name: string
          nrr?: string | null
          num_employees?: string | null
          pages?: number | null
          paused_at_step?: string | null
          revenue?: string | null
          sector?: string
          source?: string
          stage?: string
          status?: string
          team_size?: string | null
          updated_at?: string
          user_id: string
          valuation?: string | null
          website?: string | null
          website_searching?: boolean | null
        }
        Update: {
          ask_amount?: string | null
          auto_ingested?: boolean
          compressed_size?: string | null
          created_at?: string
          crunchbase_url?: string | null
          deck_size?: string | null
          deep_research_status?: string
          funding_total?: string | null
          gdrive_file_id?: string | null
          growth?: string | null
          id?: string
          last_funding_round?: string | null
          linkedin_url?: string | null
          memo_draft?: string | null
          name?: string
          nrr?: string | null
          num_employees?: string | null
          pages?: number | null
          paused_at_step?: string | null
          revenue?: string | null
          sector?: string
          source?: string
          stage?: string
          status?: string
          team_size?: string | null
          updated_at?: string
          user_id?: string
          valuation?: string | null
          website?: string | null
          website_searching?: boolean | null
        }
        Relationships: []
      }
      sources: {
        Row: {
          compressed_size: string | null
          created_at: string
          deal_id: string
          extracted_text: string | null
          file_name: string
          id: string
          original_size: string | null
          processing_status: string
          source_type: string
          storage_path: string | null
          user_id: string
        }
        Insert: {
          compressed_size?: string | null
          created_at?: string
          deal_id: string
          extracted_text?: string | null
          file_name: string
          id?: string
          original_size?: string | null
          processing_status?: string
          source_type?: string
          storage_path?: string | null
          user_id: string
        }
        Update: {
          compressed_size?: string | null
          created_at?: string
          deal_id?: string
          extracted_text?: string | null
          file_name?: string
          id?: string
          original_size?: string | null
          processing_status?: string
          source_type?: string
          storage_path?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sources_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deals"
            referencedColumns: ["id"]
          },
        ]
      }
      user_settings: {
        Row: {
          ai_model: string
          created_at: string
          deep_research_provider: string
          drive_folder: string | null
          drive_sync_enabled: boolean | null
          gmail_history_id: string | null
          gmail_label_enabled: boolean | null
          google_provider_refresh_token: string | null
          google_provider_token: string | null
          id: string
          memo_prompt: string | null
          naming_mode: string | null
          naming_pattern: string | null
          recap_naming_pattern: string | null
          spam_filter_enabled: boolean | null
          updated_at: string
          user_id: string
        }
        Insert: {
          ai_model?: string
          created_at?: string
          deep_research_provider?: string
          drive_folder?: string | null
          drive_sync_enabled?: boolean | null
          gmail_history_id?: string | null
          gmail_label_enabled?: boolean | null
          google_provider_refresh_token?: string | null
          google_provider_token?: string | null
          id?: string
          memo_prompt?: string | null
          naming_mode?: string | null
          naming_pattern?: string | null
          recap_naming_pattern?: string | null
          spam_filter_enabled?: boolean | null
          updated_at?: string
          user_id: string
        }
        Update: {
          ai_model?: string
          created_at?: string
          deep_research_provider?: string
          drive_folder?: string | null
          drive_sync_enabled?: boolean | null
          gmail_history_id?: string | null
          gmail_label_enabled?: boolean | null
          google_provider_refresh_token?: string | null
          google_provider_token?: string | null
          id?: string
          memo_prompt?: string | null
          naming_mode?: string | null
          naming_pattern?: string | null
          recap_naming_pattern?: string | null
          spam_filter_enabled?: boolean | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
