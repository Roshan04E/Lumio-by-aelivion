/**
 * Command Registry (Phase 3 scaffolding).
 *
 * One bus for everything the user can trigger — keyboard shortcuts, the Command
 * Palette (⌘K), toolbar buttons, and AI commands. Features register commands;
 * the shell never hardcodes shortcuts. Business logic lives in the command's
 * `run`, not in a UI component.
 */
export interface CommandContext {
  /** Free-form bag so a command can reach editor services without the shell coupling to it. */
  [key: string]: unknown;
}

export interface CommandDescriptor {
  id: string;
  title: string;
  /** Grouping for the palette ("Edit", "AI", "View", …). */
  category: string;
  /** e.g. "mod+z", "mod+shift+z". Parsed by the palette/shortcut layer (Phase 4). */
  keybinding?: string;
  /** Whether this command spends credits (drives palette hints). */
  cost?: "free" | "credits";
  run: (ctx: CommandContext) => void | Promise<void>;
}

export class CommandRegistry {
  private readonly commands = new Map<string, CommandDescriptor>();

  register(command: CommandDescriptor): this {
    if (this.commands.has(command.id)) {
      throw new Error(`Command "${command.id}" already registered`);
    }
    this.commands.set(command.id, command);
    return this;
  }

  get(id: string): CommandDescriptor | undefined {
    return this.commands.get(id);
  }

  list(): CommandDescriptor[] {
    return [...this.commands.values()];
  }

  byCategory(category: string): CommandDescriptor[] {
    return this.list().filter((command) => command.category === category);
  }

  findByKeybinding(keybinding: string): CommandDescriptor | undefined {
    return this.list().find((command) => command.keybinding === keybinding);
  }
}

export const commandRegistry = new CommandRegistry();
