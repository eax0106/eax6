import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { UserProfileRepository } from "./user-profile.repository";

const row = { id: "u1", email: "ada@acme.test", display_name: "Ada" };

describe("UserProfileRepository", () => {
  it("reads and renames through the pool, scoped to the one user id", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({ rows: [{ ...row, display_name: "Ada L" }] });
    const repository = new UserProfileRepository({ query } as unknown as Pool);

    await expect(repository.findById("u1")).resolves.toEqual(row);
    await expect(repository.updateDisplayName("u1", "Ada L")).resolves.toMatchObject({ display_name: "Ada L" });
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining("UPDATE users SET display_name = $2 WHERE id = $1"), ["u1", "Ada L"]);
  });

  it("answers null for an unknown user, and without a database", async () => {
    const repository = new UserProfileRepository({ query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as Pool);
    await expect(repository.findById("nobody")).resolves.toBeNull();
    await expect(repository.updateDisplayName("nobody", "X")).resolves.toBeNull();

    const offline = new UserProfileRepository(undefined);
    await expect(offline.findById("u1")).resolves.toBeNull();
    await expect(offline.updateDisplayName("u1", "X")).resolves.toBeNull();
  });
});
