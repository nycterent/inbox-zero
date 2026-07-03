import { NextResponse } from "next/server";
import prisma from "@/utils/prisma";
import { withEmailAccount } from "@/utils/middleware";
import type { Logger } from "@/utils/logger";
import { MessagingProvider } from "@/generated/prisma/enums";
import { getMessagingChannelReconnectMessage } from "@/utils/messaging/channel-validity";
import { listPrivateChannelsForUser } from "@/utils/messaging/providers/slack/channels";
import { createSlackClient } from "@/utils/messaging/providers/slack/client";

export type GetChannelTargetsResponse = Awaited<ReturnType<typeof getData>>;

export const GET = withEmailAccount(
  "user/messaging-channels/targets",
  async (request, { params }) => {
    const { channelId } = await params;
    const { emailAccountId } = request.auth;
    const result = await getData({
      emailAccountId,
      channelId,
      logger: request.logger,
    });
    return NextResponse.json(result);
  },
);

async function getData({
  emailAccountId,
  channelId,
  logger,
}: {
  emailAccountId: string;
  channelId: string;
  logger: Logger;
}) {
  const channel = await prisma.messagingChannel.findFirst({
    where: {
      id: channelId,
      emailAccountId,
      isConnected: true,
    },
    select: {
      provider: true,
      accessToken: true,
      providerUserId: true,
      teamId: true,
      teamName: true,
    },
  });

  if (channel?.provider === MessagingProvider.MATRIX) {
    // Matrix has a single implicit target: the room behind the maubot
    // webhook. There's nothing to pick, so surface it as one entry.
    return {
      targets: channel.teamId
        ? [
            {
              id: channel.teamId,
              name: channel.teamName || "Matrix",
              isPrivate: true,
            },
          ]
        : [],
    };
  }

  if (!channel?.accessToken) {
    return { targets: [], error: "Channel not found or not connected" };
  }

  try {
    switch (channel.provider) {
      case MessagingProvider.SLACK: {
        if (!channel.providerUserId) {
          return {
            targets: [],
            error: getMessagingChannelReconnectMessage(MessagingProvider.SLACK),
          };
        }

        const client = createSlackClient(channel.accessToken);
        const channels = await listPrivateChannelsForUser(
          client,
          channel.providerUserId,
        );
        return {
          targets: channels.map((c) => ({
            id: c.id,
            name: c.name,
            isPrivate: c.isPrivate,
          })),
        };
      }
      default:
        return { targets: [], error: "Unsupported provider" };
    }
  } catch (error) {
    logger.error("Failed to list channel targets", { error });
    return { targets: [], error: "Failed to list targets" };
  }
}
