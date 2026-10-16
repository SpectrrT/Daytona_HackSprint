"""A bounded demo module interface, not a general hostile-Python security boundary."""
import ast
import pathlib
import sys


def validate(source):
    if len(source.encode()) > 30000:
        raise ValueError('Checkout module exceeds 30 KB')
    tree = ast.parse(source)
    functions = [n for n in tree.body if isinstance(n, ast.FunctionDef)]
    entry = next((n for n in functions if n.name == 'checkout'), None)
    if entry is None or [a.arg for a in entry.args.args] != ['db', 'request_id', 'quantity']:
        raise ValueError('Expected checkout(db, request_id, quantity)')
    safe_calls = {'isinstance', 'type', 'len', 'any', 'all', 'str', 'int', 'bool', 'dict', 'list', 'tuple', 'set', 'range', 'min', 'max', 'sum', 'enumerate', 'zip', 'Exception', 'ValueError', 'RuntimeError', *[n.name for n in functions]}
    safe_attrs = {'execute', 'cursor', 'fetchone', 'fetchall', 'commit', 'rollback', 'in_transaction', 'lastrowid', 'rowcount', 'get', 'items', 'keys', 'values', 'append', 'strip', 'isalnum', 'isascii', 'replace', 'isalpha', 'isdigit', 'startswith', 'endswith', 'IntegrityError', 'OperationalError', 'DatabaseError', 'ProgrammingError', 'Error', 'fullmatch', 'match'}
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.Import)):
            continue
        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
            continue
        raise ValueError('Only imports, a module docstring, and function definitions are allowed')
    for node in ast.walk(tree):
        if isinstance(node, ast.Import) and any(n.name not in ('sqlite3', 're') for n in node.names):
            raise ValueError('Only sqlite3 and re imports are supported')
        if isinstance(node, (ast.ImportFrom, ast.ClassDef, ast.Global, ast.Nonlocal, ast.AsyncFunctionDef, ast.With)):
            raise ValueError('Unsupported checkout construct')
        if isinstance(node, ast.Attribute) and (node.attr.startswith('_') or node.attr not in safe_attrs):
            raise ValueError('Unsupported object operation: ' + node.attr)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id not in safe_calls:
            raise ValueError('Unsupported function: ' + node.func.id)
        if isinstance(node, ast.FunctionDef) and (node.decorator_list or node.args.defaults or node.args.kw_defaults):
            raise ValueError('Decorators and default expressions are unsupported')
    return tree


if __name__ == '__main__':
    validate(pathlib.Path(sys.argv[1]).read_text())
    print('Checkout source passed the module interface check.')
