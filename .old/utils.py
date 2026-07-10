import json
import time
import logging
from typing import TypeVar, Callable, Any, Optional
from functools import wraps

logger = logging.getLogger(__name__)

T = TypeVar('T')

def retry_operation(
    operation: Callable[..., T],
    max_retries: int = 3,
    initial_delay: float = 1.0,
    max_delay: float = 10.0,
    backoff_factor: float = 2.0,
    exceptions: tuple = (Exception,),
    on_retry: Optional[Callable[[Exception, int], None]] = None
) -> T:
    """
    A generic retry decorator that implements exponential backoff.
    
    Args:
        operation: The function to retry
        max_retries: Maximum number of retry attempts
        initial_delay: Initial delay between retries in seconds
        max_delay: Maximum delay between retries in seconds
        backoff_factor: Multiplicative factor for exponential backoff
        exceptions: Tuple of exceptions to catch and retry on
        on_retry: Optional callback function called on each retry with the exception and attempt number
        
    Returns:
        The result of the operation if successful
        
    Raises:
        The last exception encountered if all retries fail
    """
    for attempt in range(max_retries):
        try:
            return operation()
        except exceptions as e:
            if attempt == max_retries - 1:
                raise
            
            delay = min(initial_delay * (backoff_factor ** attempt), max_delay)
            
            if on_retry:
                on_retry(e, attempt + 1)
            else:
                logger.warning(
                    f"Operation failed on attempt {attempt + 1}/{max_retries}. "
                    f"Retrying in {delay:.1f} seconds. Error: {str(e)}"
                )
            
            time.sleep(delay)
    
    # This should never be reached due to the raise in the last iteration
    raise RuntimeError("Unexpected error in retry_operation")

def retry_file_operation(func: Callable) -> Callable:
    """
    A decorator specifically for retrying file operations.
    
    This decorator uses retry_operation with file-specific defaults and proper exception handling.
    
    Args:
        func: The function to decorate
        
    Returns:
        The decorated function with retry capability
    """
    @wraps(func)
    def wrapper(*args, **kwargs):
        def operation():
            return func(*args, **kwargs)
        
        return retry_operation(
            operation,
            max_retries=3,
            initial_delay=1.0,
            max_delay=5.0,
            backoff_factor=2.0,
            exceptions=(IOError, OSError, json.JSONDecodeError)
        )
    
    return wrapper

@retry_file_operation
def read_json_file(file_path: str) -> Any:
    """
    Read and parse a JSON file with retry capability.
    
    Args:
        file_path: Path to the JSON file
        
    Returns:
        Parsed JSON content
        
    Raises:
        FileNotFoundError: If the file doesn't exist
        json.JSONDecodeError: If the file contains invalid JSON
    """
    with open(file_path, 'r', encoding='utf-8') as f:
        return json.load(f)

@retry_file_operation
def write_json_file(file_path: str, data: Any, indent: int = 4) -> None:
    """
    Write data to a JSON file with retry capability.
    
    Args:
        file_path: Path to the JSON file
        data: Data to write (must be JSON serializable)
        indent: Number of spaces for indentation
        
    Raises:
        IOError: If there's an error writing to the file
        TypeError: If the data is not JSON serializable
    """
    with open(file_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=indent) 