import fs from "fs/promises";
import { Todo } from "./src/lib/todoTypes";
import { dataFile } from "./server_paths";

const TODOS_FILE = dataFile("todos.json");

export async function loadTodos(): Promise<Todo[]> {
  try {
    const data = await fs.readFile(TODOS_FILE, "utf-8");
    return JSON.parse(data) as Todo[];
  } catch (error: any) {
    if (error.code === "ENOENT") return [];
    console.error("[Todos] Error loading todos, returning fallback:", error);
    return [];
  }
}

export async function saveTodos(todos: Todo[]): Promise<void> {
  try {
    await fs.writeFile(TODOS_FILE, JSON.stringify(todos, null, 2), "utf-8");
  } catch (error) {
    console.error("[Todos] Error writing todos file:", error);
  }
}
