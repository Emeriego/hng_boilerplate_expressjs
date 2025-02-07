import AppDataSource from "../data-source";
import { UserRole } from "../enums/userRoles";
import { BadRequest } from "../middleware";
import { Organization } from "../models/organization";
import { User } from "../models/user";
import { ICreateOrganisation, IOrgService } from "../types";
import log from "../utils/logger";
import { UserOrganization, Invitation, OrgInviteToken } from "../models";
import { v4 as uuidv4 } from "uuid";
import { addEmailToQueue } from "../utils/queue";
import renderTemplate from "../views/email/renderTemplate";
import { Conflict, ResourceNotFound } from "../middleware/error";
import config from "../config/index";
const frontendBaseUrl = config.BASE_URL;
export class OrgService implements IOrgService {
  public async createOrganisation(
    payload: ICreateOrganisation,
    userId: string,
  ): Promise<{
    newOrganisation: Partial<Organization>;
  }> {
    try {
      const organisation = new Organization();
      organisation.owner_id = userId;
      Object.assign(organisation, payload);

      const newOrganisation = await AppDataSource.manager.save(organisation);

      const userOrganization = new UserOrganization();
      userOrganization.userId = userId;
      userOrganization.organizationId = newOrganisation.id;
      userOrganization.role = UserRole.ADMIN;

      await AppDataSource.manager.save(userOrganization);

      return { newOrganisation };
    } catch (error) {
      log.error(error);
      throw new BadRequest("Client error");
    }
  }

  public async removeUser(
    org_id: string,
    user_id: string,
  ): Promise<User | null> {
    const userOrganizationRepository =
      AppDataSource.getRepository(UserOrganization);
    const organizationRepository = AppDataSource.getRepository(Organization);
    const userRepository = AppDataSource.getRepository(User);

    try {
      const userOrganization = await userOrganizationRepository.findOne({
        where: { userId: user_id, organizationId: org_id },
        relations: ["user", "organization"],
      });

      if (!userOrganization) {
        return null;
      }

      await userOrganizationRepository.remove(userOrganization);

      const organization = await organizationRepository.findOne({
        where: { id: org_id, owner_id: user_id },
        relations: ["users"],
      });

      if (organization) {
        organization.users = organization.users.filter(
          (user) => user.id !== user_id,
        );
        await organizationRepository.save(organization);
      }
      if (!organization) {
        return null;
      }
      return userOrganization.user;
    } catch (error) {
      throw new Error("Failed to remove user from organization");
    }
  }

  public async getOrganizationsByUserId(
    user_id: string,
  ): Promise<Organization[]> {
    log.info(`Fetching organizations for user_id: ${user_id}`);
    try {
      const userOrganizationRepository =
        AppDataSource.getRepository(UserOrganization);

      const userOrganizations = await userOrganizationRepository.find({
        where: { userId: user_id },
        relations: ["organization"],
      });

      const organization = userOrganizations.map((org) => org.organization);

      log.info(`Organizations found: ${userOrganizations.length}`);
      return organization;
    } catch (error) {
      log.error(`Error fetching organizations for user_id: ${user_id}`, error);
      throw new Error("Failed to fetch organizations");
    }
  }

  public async getSingleOrg(
    org_id: string,
    user_id: string,
  ): Promise<Organization | null> {
    try {
      const userOrganizationRepository =
        AppDataSource.getRepository(UserOrganization);

      const userOrganization = await userOrganizationRepository.findOne({
        where: { userId: user_id, organizationId: org_id },
        relations: ["organization"],
      });

      log.error(userOrganization);

      return userOrganization?.organization || null;
    } catch (error) {
      throw new Error("Failed to fetch organization");
    }
  }
  public async updateOrganizationDetails(
    org_id: string,
    update_data: Partial<Organization>,
  ): Promise<Organization> {
    const organizationRepository = AppDataSource.getRepository(Organization);

    const organization = await organizationRepository.findOne({
      where: { id: org_id },
    });

    if (!organization) {
      throw new Error("Organization not found");
    }

    Object.assign(organization, update_data);

    try {
      await organizationRepository.update(organization.id, update_data);
      return organization;
    } catch (error) {
      throw error;
    }
  }

  public async generateInviteLink(orgId: string) {
    const organisationRepository = AppDataSource.getRepository(Organization);
    const userRepository = AppDataSource.getRepository(User);
    const userOrganizationRepository =
      AppDataSource.getRepository(UserOrganization);
    const orgInviteTokenRepository =
      AppDataSource.getRepository(OrgInviteToken);
    const userOrganization = await organisationRepository.findOne({
      where: { id: orgId },
    });
    if (!userOrganization) {
      throw new ResourceNotFound("Organization not found.");
    }

    const tokenValue = uuidv4();
    const expiresAt = new Date();
    expiresAt.setFullYear(expiresAt.getFullYear() + 1);

    const orgInvteToken = new OrgInviteToken();
    orgInvteToken.token = tokenValue;
    orgInvteToken.expires_at = expiresAt;
    orgInvteToken.organization = userOrganization;

    await orgInviteTokenRepository.save(orgInvteToken);
    const inviteLink = `${frontendBaseUrl}/accept-invite/${userOrganization.name}?token=${tokenValue}`;
    return inviteLink;
  }

  public async sendInviteLinks(orgId: string, emails: string[]): Promise<void> {
    const organisationRepository = AppDataSource.getRepository(Organization);
    const userRepository = AppDataSource.getRepository(User);
    const userOrganizationRepository =
      AppDataSource.getRepository(UserOrganization);
    const orgInviteTokenRepository =
      AppDataSource.getRepository(OrgInviteToken);
    const invitationRepository = AppDataSource.getRepository(Invitation);

    const organization = await organisationRepository.findOne({
      where: { id: orgId },
    });

    if (!organization) {
      throw new ResourceNotFound("Organization not found.");
    }

    const expiresAt = new Date();
    expiresAt.setFullYear(expiresAt.getFullYear() + 1);

    for (const email of emails) {
      const tokenValue = uuidv4();

      const orgInviteToken = new OrgInviteToken();
      orgInviteToken.token = tokenValue;
      orgInviteToken.expires_at = expiresAt;
      orgInviteToken.organization = organization;

      await orgInviteTokenRepository.save(orgInviteToken);

      const invitation = new Invitation();
      invitation.token = tokenValue;
      invitation.organization = organization;
      invitation.email = email;
      invitation.orgInviteToken = orgInviteToken;

      await invitationRepository.save(invitation);

      const inviteLink = `${frontendBaseUrl}/accept-invite/${organization.name}?token=${tokenValue}`;

      const emailContent = {
        userName: "",
        title: "Invitation to Join Organization",
        body: `<p>You have been invited to join ${organization.name} organization. Please use the following link to accept the invitation:</p><a href="${inviteLink}">Here</a>`,
      };
      const mailOptions = {
        from: "your-email@gmail.com",
        to: email,
        subject: "Invitation to Join Organization",
        html: renderTemplate("custom-email", emailContent),
      };

      addEmailToQueue(mailOptions);
    }
  }

  public async joinOrganizationByInvite(
    token: string,
    userId: string,
  ): Promise<void> {
    const organisationRepository = AppDataSource.getRepository(Organization);
    const userRepository = AppDataSource.getRepository(User);
    const userOrganizationRepository =
      AppDataSource.getRepository(UserOrganization);
    const orgInviteTokenRepository =
      AppDataSource.getRepository(OrgInviteToken);
    const invitationRepository = AppDataSource.getRepository(Invitation);

    const user = await userRepository.findOneBy({ id: userId });
    if (!user) {
      throw new ResourceNotFound("Please register to join the organization");
    }

    let organization;
    const invitation = await invitationRepository.findOne({
      where: { token: token, email: user.email },
      relations: ["organization"],
    });

    if (invitation) {
      organization = invitation.organization;
    } else {
      const orgInviteToken = await orgInviteTokenRepository.findOne({
        where: { token: token },
        relations: ["organization"],
      });

      if (!orgInviteToken) {
        throw new ResourceNotFound("Invalid invitation token.");
      }

      organization = orgInviteToken.organization;
    }

    if (!organization) {
      throw new ResourceNotFound("Organization not found.");
    }

    const existingUserOrg = await userOrganizationRepository.findOne({
      where: { user: { id: userId }, organization: { id: organization.id } },
    });

    if (existingUserOrg) {
      throw new Conflict("You are already a member.");
    }

    const userOrganization = new UserOrganization();
    userOrganization.user = user;
    userOrganization.organization = organization;
    userOrganization.role = UserRole.USER;

    await userOrganizationRepository.save(userOrganization);

    // if (invitation) {
    //   await invitationRepository.remove(invitation);
    // }
  }

  public async searchOrganizationMembers(criteria: {
    name?: string;
    email?: string;
  }): Promise<any[]> {
    const userOrganizationRepository =
      AppDataSource.getRepository(UserOrganization);

    const { name, email } = criteria;

    const query = userOrganizationRepository
      .createQueryBuilder("userOrganization")
      .leftJoinAndSelect("userOrganization.user", "user")
      .leftJoinAndSelect("userOrganization.organization", "organization")
      .where("1=1");

    if (name) {
      query.andWhere("LOWER(user.name) LIKE LOWER(:name)", {
        name: `%${name}%`,
      });
    } else if (email) {
      query.andWhere("LOWER(user.email) LIKE LOWER(:email)", {
        email: `%${email}%`,
      });
    }

    const userOrganizations = await query.getMany();

    if (userOrganizations.length > 0) {
      const organizationsMap = new Map<string, any>();

      userOrganizations.forEach((userOrg) => {
        const org = userOrg.organization;
        const user = userOrg.user;

        if (!organizationsMap.has(org.id)) {
          organizationsMap.set(org.id, {
            organizationId: org.id,
            organizationName: org.name,
            organizationEmail: org.email,
            members: [],
          });
        }

        organizationsMap.get(org.id).members.push({
          userId: user.id,
          userName: user.name,
          userEmail: user.email,
        });
      });

      return Array.from(organizationsMap.values());
    }

    return [];
  }
}
