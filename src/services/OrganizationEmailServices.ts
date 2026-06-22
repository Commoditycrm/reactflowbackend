import { EnvLoader } from "../util/EnvLoader";
import { EmailService } from "../services/EmailService"; // adjust path if needed
import { InviteUserProps } from "../interfaces/types";

export class OrganizationEmailService {
  private emailService = EmailService.getInstance();

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
