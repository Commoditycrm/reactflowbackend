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

