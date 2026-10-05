export class LifebotError extends Error {
  constructor(
    public code: string,
    message: string,
    public httpStatus?: number,
  ) {
    super(message);
  }
}
export const shapeError = () =>
  new LifebotError(
    'UPSTREAM_CONTRACT_ERROR',
    'Tracker returned an unsupported response shape. No data was returned.',
  );
