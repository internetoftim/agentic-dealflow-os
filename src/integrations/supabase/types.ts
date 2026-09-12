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
      conversion_jobs: {
        Row: {
          company_name: string | null
          created_at: string
          email: string
          error_message: string | null
          id: string
          linkedin_url: string | null
          notes: string | null
          notified_at: string | null
          page_count: number | null
          pdf_storage_path: string | null
          source_url: string
          status: string
          title: string | null
          token: string
          updated_at: string
          website: string | null
        }
        Insert: {
          company_name?: string | null
          created_at?: string
          email: string
          error_message?: string | null
          id?: string
          linkedin_url?: string | null
          notes?: string | null
          notified_at?: string | null
          page_count?: number | null
          pdf_storage_path?: string | null
          source_url: string
          status?: string
          title?: string | null
          token: string
          updated_at?: string
          website?: string | null
        }
        Update: {
          company_name?: string | null
          created_at?: string
          email?: string
          error_message?: string | null
          id?: string
          linkedin_url?: string | null
          notes?: string | null
          notified_at?: string | null
          page_count?: number | null
          pdf_storage_path?: string | null
          source_url?: string
          status?: string
          title?: string | null
          token?: string
          updated_at?: string
          website?: string | null
        }
        Relationships: []
      }
      deal_notes: {
        Row: {
          author_email: string | null
          content: string
          created_at: string
          deal_id: string
          id: string
          pinned: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          author_email?: string | null
          content: string
          created_at?: string
          deal_id: string
          id?: string
          pinned?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          author_email?: string | null
          content?: string
          created_at?: string
          deal_id?: string
          id?: string
          pinned?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      deal_people: {
        Row: {
          created_at: string
          deal_id: string
          id: string
          linkedin_url: string | null
          name: string
          title: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          deal_id: string
          id?: string
          linkedin_url?: string | null
          name: string
          title?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          deal_id?: string
          id?: string
          linkedin_url?: string | null
          name?: string
          title?: string | null
          user_id?: string
        }
        Relationships: []
      }
      deal_share_access: {
        Row: {
          accepted_at: string
          deal_id: string
          id: string
          owner_id: string
          permission: string
          revoked_at: string | null
          share_id: string
          user_id: string
        }
        Insert: {
          accepted_at?: string
          deal_id: string
          id?: string
          owner_id: string
          permission?: string
          revoked_at?: string | null
          share_id: string
          user_id: string
        }
        Update: {
          accepted_at?: string
          deal_id?: string
          id?: string
          owner_id?: string
          permission?: string
          revoked_at?: string | null
          share_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "deal_share_access_share_id_fkey"
            columns: ["share_id"]
            isOneToOne: false
            referencedRelation: "deal_shares"
            referencedColumns: ["id"]
          },
        ]
      }
      deal_shares: {
        Row: {
          created_at: string
          deal_id: string
          id: string
          owner_id: string
          permission: string
          revoked_at: string | null
          token: string
        }
        Insert: {
          created_at?: string
          deal_id: string
          id?: string
          owner_id: string
          permission?: string
          revoked_at?: string | null
          token: string
        }
        Update: {
          created_at?: string
          deal_id?: string
          id?: string
          owner_id?: string
          permission?: string
          revoked_at?: string | null
          token?: string
        }
        Relationships: []
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
          investors: string | null
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
          team_id: string | null
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
          investors?: string | null
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
          team_id?: string | null
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
          investors?: string | null
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
          team_id?: string | null
          team_size?: string | null
          updated_at?: string
          user_id?: string
          valuation?: string | null
          website?: string | null
          website_searching?: boolean | null
        }
        Relationships: []
      }
      ingest_events: {
        Row: {
          channel: string
          content_hash: string | null
          created_at: string
          deal_id: string | null
          file_name: string | null
          gmail_attachment_id: string | null
          gmail_message_id: string | null
          id: string
          mime_type: string | null
          outcome: string
          reason: string | null
          receiver_account_id: string | null
          sender: string | null
          size_bytes: number | null
          source_id: string | null
          subject: string | null
          user_id: string
        }
        Insert: {
          channel: string
          content_hash?: string | null
          created_at?: string
          deal_id?: string | null
          file_name?: string | null
          gmail_attachment_id?: string | null
          gmail_message_id?: string | null
          id?: string
          mime_type?: string | null
          outcome: string
          reason?: string | null
          receiver_account_id?: string | null
          sender?: string | null
          size_bytes?: number | null
          source_id?: string | null
          subject?: string | null
          user_id: string
        }
        Update: {
          channel?: string
          content_hash?: string | null
          created_at?: string
          deal_id?: string | null
          file_name?: string | null
          gmail_attachment_id?: string | null
          gmail_message_id?: string | null
          id?: string
          mime_type?: string | null
          outcome?: string
          reason?: string | null
          receiver_account_id?: string | null
          sender?: string | null
          size_bytes?: number | null
          source_id?: string | null
          subject?: string | null
          user_id?: string
        }
        Relationships: []
      }
      mcp_access_tokens: {
        Row: {
          created_at: string
          id: string
          last_used_at: string | null
          name: string
          revoked_at: string | null
          token_hash: string
          token_prefix: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          last_used_at?: string | null
          name: string
          revoked_at?: string | null
          token_hash: string
          token_prefix: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          last_used_at?: string | null
          name?: string
          revoked_at?: string | null
          token_hash?: string
          token_prefix?: string
          user_id?: string
        }
        Relationships: []
      }
      mcp_oauth_clients: {
        Row: {
          client_id: string
          client_name: string | null
          created_at: string
          grant_types: Json
          redirect_uris: Json
          token_endpoint_auth_method: string
        }
        Insert: {
          client_id: string
          client_name?: string | null
          created_at?: string
          grant_types?: Json
          redirect_uris: Json
          token_endpoint_auth_method?: string
        }
        Update: {
          client_id?: string
          client_name?: string | null
          created_at?: string
          grant_types?: Json
          redirect_uris?: Json
          token_endpoint_auth_method?: string
        }
        Relationships: []
      }
      mcp_oauth_codes: {
        Row: {
          client_id: string
          code: string
          code_challenge: string
          code_challenge_method: string
          consumed_at: string | null
          created_at: string
          expires_at: string
          redirect_uri: string
          scope: string | null
          user_id: string
        }
        Insert: {
          client_id: string
          code: string
          code_challenge: string
          code_challenge_method?: string
          consumed_at?: string | null
          created_at?: string
          expires_at: string
          redirect_uri: string
          scope?: string | null
          user_id: string
        }
        Update: {
          client_id?: string
          code?: string
          code_challenge?: string
          code_challenge_method?: string
          consumed_at?: string | null
          created_at?: string
          expires_at?: string
          redirect_uri?: string
          scope?: string | null
          user_id?: string
        }
        Relationships: []
      }
      mcp_oauth_tokens: {
        Row: {
          access_token_hash: string
          client_id: string
          created_at: string
          expires_at: string
          id: string
          refresh_token_hash: string | null
          revoked_at: string | null
          scope: string | null
          user_id: string
        }
        Insert: {
          access_token_hash: string
          client_id: string
          created_at?: string
          expires_at: string
          id?: string
          refresh_token_hash?: string | null
          revoked_at?: string | null
          scope?: string | null
          user_id: string
        }
        Update: {
          access_token_hash?: string
          client_id?: string
          created_at?: string
          expires_at?: string
          id?: string
          refresh_token_hash?: string | null
          revoked_at?: string | null
          scope?: string | null
          user_id?: string
        }
        Relationships: []
      }
      mcp_tool_calls: {
        Row: {
          arguments: Json | null
          created_at: string
          deal_id: string | null
          error_message: string | null
          id: string
          success: boolean
          tool_name: string
          user_id: string
        }
        Insert: {
          arguments?: Json | null
          created_at?: string
          deal_id?: string | null
          error_message?: string | null
          id?: string
          success?: boolean
          tool_name: string
          user_id: string
        }
        Update: {
          arguments?: Json | null
          created_at?: string
          deal_id?: string | null
          error_message?: string | null
          id?: string
          success?: boolean
          tool_name?: string
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          admin_notes: string | null
          approval_requested_at: string
          approval_status: Database["public"]["Enums"]["approval_status"]
          approved_at: string | null
          approved_by: string | null
          avatar_url: string | null
          created_at: string
          display_name: string | null
          email: string | null
          id: string
          is_legacy_user: boolean
          last_seen_at: string | null
          rejected_at: string | null
          rejected_by: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          admin_notes?: string | null
          approval_requested_at?: string
          approval_status?: Database["public"]["Enums"]["approval_status"]
          approved_at?: string | null
          approved_by?: string | null
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          email?: string | null
          id?: string
          is_legacy_user?: boolean
          last_seen_at?: string | null
          rejected_at?: string | null
          rejected_by?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          admin_notes?: string | null
          approval_requested_at?: string
          approval_status?: Database["public"]["Enums"]["approval_status"]
          approved_at?: string | null
          approved_by?: string | null
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          email?: string | null
          id?: string
          is_legacy_user?: boolean
          last_seen_at?: string | null
          rejected_at?: string | null
          rejected_by?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      receiver_accounts: {
        Row: {
          created_at: string
          email: string
          enabled: boolean
          gmail_history_id: string | null
          google_access_token: string | null
          google_refresh_token: string | null
          id: string
          last_error: string | null
          last_polled_at: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          email: string
          enabled?: boolean
          gmail_history_id?: string | null
          google_access_token?: string | null
          google_refresh_token?: string | null
          id?: string
          last_error?: string | null
          last_polled_at?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          email?: string
          enabled?: boolean
          gmail_history_id?: string | null
          google_access_token?: string | null
          google_refresh_token?: string | null
          id?: string
          last_error?: string | null
          last_polled_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      receiver_invites: {
        Row: {
          created_at: string
          expires_at: string
          id: string
          note: string | null
          token_hash: string
          used_at: string | null
          used_by_email: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          expires_at: string
          id?: string
          note?: string | null
          token_hash: string
          used_at?: string | null
          used_by_email?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          id?: string
          note?: string | null
          token_hash?: string
          used_at?: string | null
          used_by_email?: string | null
          user_id?: string
        }
        Relationships: []
      }
      sources: {
        Row: {
          compressed_size: string | null
          content_hash: string | null
          created_at: string
          deal_id: string
          extracted_text: string | null
          file_name: string
          gmail_message_id: string | null
          id: string
          original_size: string | null
          preview_images: Json | null
          processing_status: string
          source_type: string
          storage_path: string | null
          user_id: string
        }
        Insert: {
          compressed_size?: string | null
          content_hash?: string | null
          created_at?: string
          deal_id: string
          extracted_text?: string | null
          file_name: string
          gmail_message_id?: string | null
          id?: string
          original_size?: string | null
          preview_images?: Json | null
          processing_status?: string
          source_type?: string
          storage_path?: string | null
          user_id: string
        }
        Update: {
          compressed_size?: string | null
          content_hash?: string | null
          created_at?: string
          deal_id?: string
          extracted_text?: string | null
          file_name?: string
          gmail_message_id?: string | null
          id?: string
          original_size?: string | null
          preview_images?: Json | null
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
      team_members: {
        Row: {
          created_at: string
          id: string
          role: string
          team_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role?: string
          team_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: string
          team_id?: string
          user_id?: string
        }
        Relationships: []
      }
      teams: {
        Row: {
          created_at: string
          id: string
          invite_code: string
          name: string
          owner_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          invite_code?: string
          name: string
          owner_id: string
        }
        Update: {
          created_at?: string
          id?: string
          invite_code?: string
          name?: string
          owner_id?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      user_settings: {
        Row: {
          agent_mode_enabled: boolean
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
          intake_slug: string | null
          memo_prompt: string | null
          naming_mode: string | null
          naming_pattern: string | null
          recap_naming_pattern: string | null
          spam_filter_enabled: boolean | null
          text_only_llm: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          agent_mode_enabled?: boolean
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
          intake_slug?: string | null
          memo_prompt?: string | null
          naming_mode?: string | null
          naming_pattern?: string | null
          recap_naming_pattern?: string | null
          spam_filter_enabled?: boolean | null
          text_only_llm?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          agent_mode_enabled?: boolean
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
          intake_slug?: string | null
          memo_prompt?: string | null
          naming_mode?: string | null
          naming_pattern?: string | null
          recap_naming_pattern?: string | null
          spam_filter_enabled?: boolean | null
          text_only_llm?: boolean
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
      accept_share_token: { Args: { _token: string }; Returns: string }
      can_access_deal: {
        Args: { _deal_id: string; _user_id: string }
        Returns: boolean
      }
      create_team: {
        Args: { _name: string }
        Returns: Database["public"]["Tables"]["teams"]["Row"]
      }
      is_team_member: {
        Args: { _team_id: string; _user_id: string }
        Returns: boolean
      }
      join_team: {
        Args: { _invite_code: string }
        Returns: Database["public"]["Tables"]["teams"]["Row"]
      }
      leave_team: { Args: Record<PropertyKey, never>; Returns: undefined }
      remove_team_member: {
        Args: { _member_user_id: string }
        Returns: undefined
      }
      get_team_roster: {
        Args: Record<PropertyKey, never>
        Returns: {
          display_name: string | null
          email: string | null
          joined_at: string
          role: string
          user_id: string
        }[]
      }
      get_conversion_job: {
        Args: { _email: string; _token: string }
        Returns: {
          company_name: string
          created_at: string
          email: string
          error_message: string
          id: string
          linkedin_url: string
          notes: string
          page_count: number
          pdf_storage_path: string
          source_url: string
          status: string
          title: string
          token: string
          updated_at: string
          website: string
        }[]
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      is_user_approved: { Args: { _user_id: string }; Returns: boolean }
      lookup_share_token: {
        Args: { _token: string }
        Returns: {
          deal_id: string
          deal_name: string
          owner_display_name: string
          revoked: boolean
        }[]
      }
      sync_my_profile: {
        Args: { _avatar_url: string; _display_name: string; _email: string }
        Returns: {
          admin_notes: string | null
          approval_requested_at: string
          approval_status: Database["public"]["Enums"]["approval_status"]
          approved_at: string | null
          approved_by: string | null
          avatar_url: string | null
          created_at: string
          display_name: string | null
          email: string | null
          id: string
          is_legacy_user: boolean
          last_seen_at: string | null
          rejected_at: string | null
          rejected_by: string | null
          updated_at: string
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "profiles"
          isOneToOne: true
          isSetofReturn: false
        }
      }
    }
    Enums: {
      app_role: "admin" | "user"
      approval_status: "pending" | "approved" | "rejected"
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
    Enums: {
      app_role: ["admin", "user"],
      approval_status: ["pending", "approved", "rejected"],
    },
  },
} as const
