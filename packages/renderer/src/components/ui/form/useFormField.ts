import { FieldContextKey } from 'vee-validate'
import { computed, inject, unref, useId, type Ref } from 'vue'

export interface FormFieldContext {
  id: string
  name: Ref<string>
  errorMessage: Ref<string | undefined>
  isInvalid: Ref<boolean>
}

export function useFormField(): FormFieldContext {
  const field = inject(FieldContextKey)
  if (!field) {
    throw new Error('useFormField must be used inside a FormField/FormItem')
  }

  return {
    id: useId(),
    name: computed(() => unref(field.name)),
    errorMessage: computed(() => unref(field.errorMessage)),
    isInvalid: computed(() => field.meta.touched && !field.meta.valid),
  }
}
