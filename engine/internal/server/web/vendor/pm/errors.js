/** Error returned when a Privatemode API endpoint responds unsuccessfully. */
export class PrivatemodeAPIError extends Error {
    status;
    body;
    headers;
    name = 'PrivatemodeAPIError';
    constructor(message, status, body, headers, options) {
        super(message, options);
        this.status = status;
        this.body = body;
        this.headers = headers;
    }
}
//# sourceMappingURL=errors.js.map