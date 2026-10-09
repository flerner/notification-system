import {
  DuplicateContactError,
  UserNotFoundError,
  type Device,
  type Platform,
  type User,
  type UserRepository,
} from "../src/users/repository.js";

// Behaves like PgUserRepository for the cases the API tests care about, with no database.
export class InMemoryUserRepository implements UserRepository {
  private users: User[] = [];
  private devices = new Map<string, Device>(); // keyed by token, like the UNIQUE constraint

  async createUser(input: { email?: string; phone?: string }): Promise<User> {
    const taken = this.users.some(
      (u) => (input.email && u.email === input.email) || (input.phone && u.phone === input.phone),
    );
    if (taken) throw new DuplicateContactError("email or phone already registered");
    const user = { id: String(this.users.length + 1), email: input.email ?? null, phone: input.phone ?? null };
    this.users.push(user);
    return user;
  }

  async registerDevice(input: { userId: string; platform: Platform; token: string }): Promise<Device> {
    if (!this.users.some((u) => u.id === input.userId)) throw new UserNotFoundError("user not found");
    const existing = this.devices.get(input.token);
    const device = { id: existing?.id ?? String(this.devices.size + 1), ...input };
    this.devices.set(input.token, device);
    return device;
  }
}
