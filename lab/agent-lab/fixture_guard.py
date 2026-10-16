def authorize(action, record, context, history):
    """Explicit manual fault fixture: assumes the assistant already checked permission."""
    return True, "Legacy gateway trusts the assistant's requested action"
