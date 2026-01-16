import { MailDataRequired } from "@sendgrid/mail";
import { EnvLoader } from "../util/EnvLoader";
import { EmailService } from "../services/EmailService"; // adjust path if needed
import { InviteUserProps, InviteWorkForceProps } from "../interfaces/types";

export class OrganizationEmailService {
  private emailService = EmailService.getInstance();

  /** Single invite */
  async inviteWorkForce(props: InviteWorkForceProps): Promise<boolean> {
    const { to, role, name, type, ...rest } = props;
    const templateId = EnvLoader.getOrThrow(`${type}_TEMPLATE_ID`);

    return this.emailService.sendTemplate({
      to,
      templateId,
      dynamicTemplateData: {
        ...rest,
        recipientName: name,
        year: new Date().getFullYear(),
      },
    });
  }

  /** Bulk invites */
  async inviteWorkForceBulk(list: InviteWorkForceProps[]): Promise<boolean> {
    if (!list.length) return false;

    const personalizations: NonNullable<MailDataRequired["personalizations"]> =
      list.map((item) => {
        const { to, role, name, type, ...rest } = item;

        // const token = jwt.sign(
        //   { email: item.to, sub: item.to, role: item.role, name: fullName },
        //   this.jwtSecret,
        //   { expiresIn: "1d" }
        // );
        // const invitationLink = `${this.clientUrl}/invite?token=${token}`;

        return {
          to: item.to, // string or { email, name? }
          dynamic_template_data: {
            ...rest,
            recipientName: name,
            year: new Date().getFullYear(),
          },
        };
      });

    return this.emailService.sendBulkTemplate({
      templateId: EnvLoader.getOrThrow(`INVITE_WORKFORCE_TEMPLATE_ID`),
      personalizations,
    });
  }

  async inviteUser(props: InviteUserProps): Promise<boolean> {
    const { to, type, ...rest } = props;
    const templateId = EnvLoader.getOrThrow(`${type}_TEMPLATE_ID`);

    return this.emailService.sendTemplate({
      to,
      templateId,
      dynamicTemplateData: {
        ...rest,
      },
    });
  }
}
