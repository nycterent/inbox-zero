// Matrix is a send-only channel: delivery is delegated to a maubot webhook
// that already handles E2EE. We just POST markdown text with a shared secret.

export async function sendMatrixMessage(
  channel: { teamId: string; accessToken: string | null },
  markdown: string,
): Promise<void> {
  if (!channel.accessToken) {
    throw new Error("Matrix channel is missing its webhook secret");
  }

  const response = await fetch(channel.teamId, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Webhook-Secret": channel.accessToken,
    },
    body: JSON.stringify({ text: markdown }),
  });

  if (!response.ok) {
    throw new Error(
      `Matrix webhook request failed with status ${response.status}`,
    );
  }
}
