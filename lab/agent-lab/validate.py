"""Small data-only authorization function gate; no general-purpose generated programs."""
import ast
import sys
from pathlib import Path

BUILTINS = {"len", "int", "str", "bool", "any", "all", "sum", "min", "max", "isinstance", "type", "set", "tuple", "list", "dict", "sorted"}
NODES = {"Module", "FunctionDef", "arguments", "arg", "If", "Return", "Assign", "AnnAssign", "Expr", "Name", "Load", "Store", "Constant", "Dict", "List", "Tuple", "Compare", "BoolOp", "UnaryOp", "BinOp", "Subscript", "Call", "Attribute", "IfExp", "GeneratorExp", "ListComp", "comprehension", "And", "Or", "Not", "Eq", "NotEq", "In", "NotIn", "Lt", "LtE", "Gt", "GtE", "Is", "IsNot", "Add", "Sub", "Mult", "Div", "FloorDiv", "Mod", "USub", "keyword"}

def validate(source):
    if len(source.encode()) > 24000: raise ValueError("Guard source too large")
    tree = ast.parse(source)
    body = [node for node in tree.body if not (isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str))]
    if len(body) != 1 or not isinstance(body[0], ast.FunctionDef) or body[0].name != "authorize": raise ValueError("Provide only authorize(action, record, context, history)")
    fn = body[0]
    if [arg.arg for arg in fn.args.args] != ["action", "record", "context", "history"] or fn.args.defaults or fn.args.kwonlyargs or fn.args.vararg or fn.args.kwarg or fn.decorator_list or fn.returns: raise ValueError("Unexpected guard signature")
    nodes = list(ast.walk(tree))
    if len(nodes) > 4000: raise ValueError("Guard AST too large")
    for node in nodes:
        if type(node).__name__ not in NODES: raise ValueError("Unsupported guard construct: " + type(node).__name__)
        if isinstance(node, ast.Name) and node.id.startswith("__"): raise ValueError("Private names forbidden")
        if isinstance(node, ast.Attribute) and node.attr not in {"get", "startswith", "endswith", "items", "values", "keys"}: raise ValueError("Unsupported attribute")
        if isinstance(node, ast.Call) and not (isinstance(node.func, ast.Name) and node.func.id in BUILTINS or isinstance(node.func, ast.Attribute) and node.func.attr in {"get", "startswith", "endswith", "items", "values", "keys"}): raise ValueError("Unsupported guard call")
    return tree

if __name__ == "__main__":
    validate(Path(sys.argv[1]).read_text()); print("Guard validated")
