from typing import Dict, Optional

from aws_lambda_powertools import Logger
from langchain_aws import BedrockEmbeddings
from langchain_postgres import PGVector

logger = Logger(service="data-ingestion")


def get_vectorstore(
    collection_name: str,
    embeddings: BedrockEmbeddings,
    dbname: str,
    user: str,
    password: str,
    host: str,
    port: int
) -> Optional[PGVector]:
    """
    Initialize and return a PGVector instance.

    Args:
    collection_name (str): The name of the collection.
    embeddings (BedrockEmbeddings): The embeddings instance.
    dbname (str): The name of the database.
    user (str): The database user.
    password (str): The database password.
    host (str): The database host.
    port (int): The database port.

    Returns:
    Optional[PGVector]: The initialized PGVector instance, or None if an error occurred.
    """
    try:
        connection_string = (
            f"postgresql+psycopg://{user}:{password}@{host}:{port}/{dbname}?sslmode=require"
        )

        logger.info("Initializing the VectorStore")
        vectorstore = PGVector(
            embeddings=embeddings,
            collection_name=collection_name,
            connection=connection_string,
            use_jsonb=True
        )

        logger.info("VectorStore initialized")
        return vectorstore, connection_string

    except Exception as e:
        logger.exception("Error initializing vector store")
        return None
