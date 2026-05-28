export interface TodoState {
  todos: TodoItem[]
  nextId: number
}

export interface TodoItem {
  id: number
  text: string
  status: 'pending' | 'in_progress' | 'completed'
}
