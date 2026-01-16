import { BacklogItemType } from "./ogm.types";

export interface SendEmailProps {
  to: string;
  type: string;
}

export type InviteWorkForceProps = SendEmailProps & {
  senderName: string;
  organizationName: string;
  role: string;
  inviteLink: string;
  name: string;
};

export type InviteUserProps = SendEmailProps & {
  inviteLink: string;
  inviterName: string;
  orgName: string;
};

export type GeneratedTask = {
  id: string;
  content: string;
  description: string;
  type:BacklogItemType | null
};


export type ImportSheetResult = {
  createdCount: number;
  parentLinksCreated: number;
  sprintLinksCreated: number;
  skippedCount: number;
  errors: string[];
};
