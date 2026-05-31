import { NextResponse } from "#adapter/nextShim.js";
import { resolveKiroModels, transformKiroModels } from "#lib/kiroModels.js";
import { getProviderConnections } from "#models";
import { PROVIDER_MODELS } from "#open-sse/config/providerModels.js";
import fs from "fs/promises";
import path from "path";

/**
 * POST /api/providers/kiro/sync-models
 * Fetch models from Kiro API and update providerModels.js
 */
export async function POST(request) {
  try {
    const connections = await getProviderConnections();
    const kiroConnections = connections.filter(c => c.provider === "kiro" && c.isActive);

    if (kiroConnections.length === 0) {
      return NextResponse.json(
        { error: "No active Kiro connection found" },
        { status: 400 }
      );
    }

    const activeAccount = kiroConnections[0];

    const result = await resolveKiroModels({
      accessToken: activeAccount.accessToken,
      refreshToken: activeAccount.refreshToken,
      providerSpecificData: activeAccount.providerSpecificData
    }, { forceRefresh: true });

    if (!result || !result.models || result.models.length === 0) {
      return NextResponse.json(
        { error: "No models returned from Kiro API" },
        { status: 500 }
      );
    }

    const models = transformKiroModels(result);

    // Update providerModels.js file
    const configPath = path.join(process.cwd(), "server", "open-sse", "config", "providerModels.js");
    let fileContent = await fs.readFile(configPath, "utf-8");

    const krSectionRegex = /kr:\s*\[[\s\S]*?\],/;
    const newKrSection = `kr: [  // Kiro AI\n${models.map(m => {
      const stripStr = m.strip ? `, strip: ${JSON.stringify(m.strip)}` : "";
      return `    { id: "${m.id}", name: "${m.name}"${stripStr} }`;
    }).join(",\n")}\n  ],`;

    fileContent = fileContent.replace(krSectionRegex, newKrSection);
    await fs.writeFile(configPath, fileContent, "utf-8");

    PROVIDER_MODELS.kr = models;

    return NextResponse.json({
      success: true,
      modelsCount: models.length,
      models
    });

  } catch (error) {
    console.error("Error syncing Kiro models:", error);
    return NextResponse.json(
      { error: error.message || "Failed to sync Kiro models" },
      { status: 500 }
    );
  }
}
