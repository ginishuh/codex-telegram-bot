export class UserVisibleError extends Error {
  constructor(message) {
    super(message);
    this.name = "UserVisibleError";
  }
}

export function logError(context, error) {
  console.error(`[${context}]`, error?.stack || error?.message || error);
}

export function toUserMessage(error, fallbackText) {
  if (error instanceof UserVisibleError) {
    return error.message;
  }
  return `${fallbackText}\n\n서비스 로그를 확인해주세요.`;
}
