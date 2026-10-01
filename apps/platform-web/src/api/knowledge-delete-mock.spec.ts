import { afterEach, expect, it, vi } from "vitest"
vi.mock("./http", async importOriginal => ({ ...await importOriginal<typeof import("./http")>(), isLiveApi: false }))
import { api } from "./client"
import { mockKnowledgeChunks, mockKnowledgeDocuments, mockKnowledgeSources } from "./mock/data"
const saved = structuredClone({ documents: mockKnowledgeDocuments, sources: mockKnowledgeSources, chunks: mockKnowledgeChunks })
afterEach(() => {
  mockKnowledgeDocuments.splice(0, mockKnowledgeDocuments.length, ...structuredClone(saved.documents))
  mockKnowledgeSources.splice(0, mockKnowledgeSources.length, ...structuredClone(saved.sources))
  mockKnowledgeChunks.splice(0, mockKnowledgeChunks.length, ...structuredClone(saved.chunks))
})

it("removes one document and its chunks, updates its source and keeps all other records", async () => {
  const document = saved.documents[0]
  const source = saved.sources.find(source => source.id === document.sourceId)!
  await api.deleteKnowledgeDocument(document.id)
  expect(mockKnowledgeDocuments).toEqual(saved.documents.slice(1))
  expect(mockKnowledgeChunks).toEqual(saved.chunks.filter(chunk => chunk.documentId !== document.id))
  const updated = await api.getKnowledgeSource(source.id)
  expect(updated.documentCount).toBe(source.documentCount - 1)
  expect(updated.chunkCount).toBe(source.chunkCount - (document.chunkCount ?? 0))
  expect(mockKnowledgeSources.filter(candidate => candidate.id !== source.id)).toEqual(saved.sources.filter(candidate => candidate.id !== source.id))
})

it("rejects a missing document without mutating other records", async () => {
  await expect(api.deleteKnowledgeDocument("doc_missing")).rejects.toThrow("Document not found")
  expect(mockKnowledgeDocuments).toEqual(saved.documents)
  expect(mockKnowledgeChunks).toEqual(saved.chunks)
  expect(mockKnowledgeSources).toEqual(saved.sources)
})
