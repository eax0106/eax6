const fs = require('fs');
const path = require('path');

const mockDataPath = path.join(__dirname, '..', '..', '..', '..', '..', '..', 'OneDrive', 'Desktop', 'Alter Engine frontend 1.0', 'src', 'api', 'mock', 'data.ts');
let content = fs.readFileSync(mockDataPath, 'utf8');

const additionalData = `
// Phase 7 Mock Data

import { 
  KnowledgeSource, 
  KnowledgeDocument, 
  KnowledgeChunk,
  IntegrationDefinition,
  Connection,
  Credential,
  WhatsAppChannel,
  MemoryConfiguration
} from "../types"

export const mockKnowledgeSources: KnowledgeSource[] = [
  {
    id: "ks_01",
    name: "Product Documentation",
    type: "website",
    status: "ready",
    documentCount: 42,
    chunkCount: 840,
    lastSyncedAt: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
  },
  {
    id: "ks_02",
    name: "Support Policies",
    type: "file_upload",
    status: "ready",
    documentCount: 5,
    chunkCount: 120,
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 10).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 10).toISOString(),
  },
  {
    id: "ks_03",
    name: "Internal Wiki",
    type: "notion",
    status: "syncing",
    documentCount: 150,
    chunkCount: 3000,
    lastSyncedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 7).toISOString(),
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 60).toISOString(),
    updatedAt: new Date().toISOString(),
    connectionId: "conn_02"
  },
  {
    id: "ks_04",
    name: "Legacy FAQ",
    type: "file_upload",
    status: "failed",
    documentCount: 1,
    chunkCount: 0,
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString(),
  }
]

export const mockKnowledgeDocuments: KnowledgeDocument[] = [
  {
    id: "doc_01",
    sourceId: "ks_02",
    name: "refund-policy.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1024 * 1024 * 2.5, // 2.5MB
    status: "indexed",
    chunkCount: 42,
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 10).toISOString(),
    indexedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 10).toISOString(),
  },
  {
    id: "doc_02",
    sourceId: "ks_02",
    name: "product-guide.md",
    mimeType: "text/markdown",
    sizeBytes: 1024 * 45, // 45KB
    status: "indexed",
    chunkCount: 31,
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 10).toISOString(),
    indexedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 10).toISOString(),
  },
  {
    id: "doc_03",
    sourceId: "ks_04",
    name: "old-faq.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1024 * 1024 * 15,
    status: "failed",
    error: { code: "UNSUPPORTED_FORMAT", message: "Document contains unextractable image text without OCR." },
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString(),
  },
]

export const mockKnowledgeChunks: KnowledgeChunk[] = [
  {
    id: "chunk_018",
    sourceId: "ks_02",
    documentId: "doc_01",
    index: 18,
    contentPreview: "Annual subscriptions may receive a prorated refund if cancelled within the first 30 days of the billing cycle. After 30 days, no refunds will be issued for annual plans.",
    tokenCount: 45,
    embeddingStatus: "indexed",
  },
  {
    id: "chunk_019",
    sourceId: "ks_02",
    documentId: "doc_01",
    index: 19,
    contentPreview: "Monthly subscriptions are non-refundable. If you cancel a monthly subscription, you will retain access to the platform until the end of your current billing period.",
    tokenCount: 38,
    embeddingStatus: "indexed",
  }
]

export const mockMemoryConfig: MemoryConfiguration = {
  conversationMemoryEnabled: true,
  workflowMemoryEnabled: true,
  workspaceMemoryEnabled: true,
  retentionDays: 90,
  etag: '"memory-0"',
}

export const mockIntegrationDefinitions: IntegrationDefinition[] = [
  {
    id: "int_slack",
    name: "Slack",
    category: "Communication",
    description: "Send messages, read channels, and interact with users in Slack.",
    capabilities: ["Send messages", "Read messages", "Manage channels"],
    authType: "oauth",
    available: true,
  },
  {
    id: "int_gmail",
    name: "Gmail",
    category: "Communication",
    description: "Send and receive emails from your Workspace.",
    capabilities: ["Send emails", "Read inbox", "Manage drafts"],
    authType: "oauth",
    available: true,
  },
  {
    id: "int_github",
    name: "GitHub",
    category: "Development",
    description: "Manage repositories, issues, and pull requests.",
    capabilities: ["Read code", "Manage issues", "Create PRs"],
    authType: "oauth",
    available: true,
  },
  {
    id: "int_postgres",
    name: "PostgreSQL",
    category: "Data",
    description: "Connect directly to a PostgreSQL database.",
    capabilities: ["Execute queries", "Read schema"],
    authType: "credentials",
    available: true,
  },
  {
    id: "int_openai",
    name: "OpenAI",
    category: "AI",
    description: "Use OpenAI models for completion and analysis.",
    capabilities: ["Chat completion", "Embeddings"],
    authType: "api_key",
    available: true,
  },
  {
    id: "int_notion",
    name: "Notion",
    category: "Productivity",
    description: "Read and write to Notion databases and pages.",
    capabilities: ["Read pages", "Write blocks"],
    authType: "oauth",
    available: true,
  }
]

export const mockCredentials: Credential[] = [
  {
    id: "cred_01",
    name: "Slack OAuth — Acme",
    type: "oauth",
    provider: "Slack",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 60).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 60).toISOString(),
    lastUsedAt: new Date().toISOString(),
    usedByConnectionIds: ["conn_01"]
  },
  {
    id: "cred_02",
    name: "OpenAI Production",
    type: "api_key",
    provider: "OpenAI",
    maskedValue: "sk_••••••••7Q2M",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 120).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 120).toISOString(),
    lastUsedAt: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
    usedByConnectionIds: ["conn_04"]
  },
  {
    id: "cred_03",
    name: "Notion Internal",
    type: "oauth",
    provider: "Notion",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString(),
    usedByConnectionIds: ["conn_02"]
  }
]

export const mockConnections: Connection[] = [
  {
    id: "conn_01",
    integrationId: "int_slack",
    name: "Acme Engineering Slack",
    status: "connected",
    credentialId: "cred_01",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 60).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 60).toISOString(),
    lastCheckedAt: new Date(Date.now() - 1000 * 60 * 2).toISOString(),
  },
  {
    id: "conn_02",
    integrationId: "int_notion",
    name: "Acme Corp Notion",
    status: "connected",
    credentialId: "cred_03",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString(),
    lastCheckedAt: new Date(Date.now() - 1000 * 60 * 15).toISOString(),
  },
  {
    id: "conn_03",
    integrationId: "int_gmail",
    name: "Support Shared Inbox",
    status: "expired",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 10).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 10).toISOString(),
    lastCheckedAt: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
  },
  {
    id: "conn_04",
    integrationId: "int_openai",
    name: "OpenAI Prod Link",
    status: "connected",
    credentialId: "cred_02",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 120).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 120).toISOString(),
    lastCheckedAt: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
  }
]

export const mockWhatsAppChannels: WhatsAppChannel[] = [
  {
    id: "wa_01",
    name: "Customer Support WA",
    phoneNumber: "+1 (555) 123-4567",
    status: "connected",
    provider: "meta",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 15).toISOString(),
  }
]
`;

fs.writeFileSync(mockDataPath, content + additionalData, 'utf8');
console.log('Appended mock data');
