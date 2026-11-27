"""Cloud errors with HTTP status and a stable machine-readable code."""


class CloudError(Exception):
    def __init__(self, code, message, status=400, hint=''):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.hint = hint

    def to_dict(self):
        return {
            'success': False,
            'error': {
                'code': self.code,
                'message': self.message,
                'hint': self.hint,
            },
        }


def auth_required():
    return CloudError('E_AUTH_REQUIRED', 'Cần đăng nhập Cloud.', 401)
