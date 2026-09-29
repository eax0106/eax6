import { Injectable } from "@nestjs/common";
import type { Pool } from "pg";

export interface UserProfileRow {
  id: string;
  email: string;
  display_name: string | null;
}

@Injectable()
export class UserProfileRepository {
  constructor(private readonly pool: Pool | undefined) {}

  async findById(userId: string): Promise<UserProfileRow | null> {
    if (!this.pool) {
      return null;
    }
    const result = await this.pool.query<UserProfileRow>(
      "SELECT id, email, display_name FROM users WHERE id = $1",
      [userId],
    );
    return result.rows[0] ?? null;
  }

  async updateDisplayName(userId: string, displayName: string): Promise<UserProfileRow | null> {
    if (!this.pool) {
      return null;
    }
    const result = await this.pool.query<UserProfileRow>(
      "UPDATE users SET display_name = $2 WHERE id = $1 RETURNING id, email, display_name",
      [userId, displayName],
    );
    return result.rows[0] ?? null;
  }
}
