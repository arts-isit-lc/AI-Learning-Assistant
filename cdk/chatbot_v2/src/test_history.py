"""Unit tests for the history manager module."""

import pytest
from unittest.mock import MagicMock, patch
from history import (
    load_chat_history,
    get_bounded_history,
    persist_message_pair,
    MAX_PROMPT_TURNS,
    MAX_RETRIEVAL_TURNS,
)


class TestGetBoundedHistory:
    """Tests for get_bounded_history function."""

    def test_empty_history_returns_empty(self):
        assert get_bounded_history([], 10) == []

    def test_history_shorter_than_bound_returns_copy(self):
        history = [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "hi"},
        ]
        result = get_bounded_history(history, 5)
        assert result == history
        # Should be a copy, not the same reference
        assert result is not history

    def test_history_exactly_at_bound(self):
        history = [
            {"role": "user", "content": f"msg {i}"}
            if i % 2 == 0
            else {"role": "assistant", "content": f"reply {i}"}
            for i in range(20)  # 10 turns * 2 messages
        ]
        result = get_bounded_history(history, 10)
        assert len(result) == 20
        assert result == history

    def test_history_longer_than_bound_returns_last_n(self):
        history = [
            {"role": "user", "content": f"msg {i}"}
            if i % 2 == 0
            else {"role": "assistant", "content": f"reply {i}"}
            for i in range(30)  # 15 turns
        ]
        result = get_bounded_history(history, 10)
        # Should take last 20 messages (10 turns * 2)
        assert len(result) == 20
        assert result == history[-20:]

    def test_max_prompt_turns_bounds_to_20_messages(self):
        history = [{"role": "user", "content": f"m{i}"} for i in range(40)]
        result = get_bounded_history(history, MAX_PROMPT_TURNS)
        assert len(result) == 20

    def test_max_retrieval_turns_bounds_to_8_messages(self):
        history = [{"role": "user", "content": f"m{i}"} for i in range(20)]
        result = get_bounded_history(history, MAX_RETRIEVAL_TURNS)
        assert len(result) == 8

    def test_single_turn_with_max_turns_1(self):
        history = [
            {"role": "user", "content": "a"},
            {"role": "assistant", "content": "b"},
            {"role": "user", "content": "c"},
            {"role": "assistant", "content": "d"},
        ]
        result = get_bounded_history(history, 1)
        assert len(result) == 2
        assert result == [
            {"role": "user", "content": "c"},
            {"role": "assistant", "content": "d"},
        ]


class TestLoadChatHistory:
    """Tests for load_chat_history function."""

    def test_returns_history_from_dynamo(self):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {
            "Item": {
                "SessionId": "sess-1",
                "History": [
                    {"role": "user", "content": "hello"},
                    {"role": "assistant", "content": "hi there"},
                ],
            }
        }
        mock_resource = MagicMock()
        mock_resource.Table.return_value = mock_table

        result = load_chat_history("table-name", "sess-1", dynamodb_resource=mock_resource)
        assert result == [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "hi there"},
        ]
        mock_resource.Table.assert_called_once_with("table-name")
        mock_table.get_item.assert_called_once_with(Key={"SessionId": "sess-1"})

    def test_returns_empty_list_when_no_item(self):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {}
        mock_resource = MagicMock()
        mock_resource.Table.return_value = mock_table

        result = load_chat_history("table-name", "sess-1", dynamodb_resource=mock_resource)
        assert result == []

    def test_returns_empty_list_when_no_history_attribute(self):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {"Item": {"SessionId": "sess-1"}}
        mock_resource = MagicMock()
        mock_resource.Table.return_value = mock_table

        result = load_chat_history("table-name", "sess-1", dynamodb_resource=mock_resource)
        assert result == []

    def test_returns_empty_list_when_history_is_not_list(self):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {
            "Item": {"SessionId": "sess-1", "History": "invalid"}
        }
        mock_resource = MagicMock()
        mock_resource.Table.return_value = mock_table

        result = load_chat_history("table-name", "sess-1", dynamodb_resource=mock_resource)
        assert result == []

    def test_returns_empty_list_on_exception(self):
        mock_table = MagicMock()
        mock_table.get_item.side_effect = Exception("DynamoDB error")
        mock_resource = MagicMock()
        mock_resource.Table.return_value = mock_table

        result = load_chat_history("table-name", "sess-1", dynamodb_resource=mock_resource)
        assert result == []


class TestPersistMessagePair:
    """Tests for persist_message_pair function."""

    def test_persists_message_pair_to_dynamo(self):
        mock_table = MagicMock()
        mock_resource = MagicMock()
        mock_resource.Table.return_value = mock_table

        persist_message_pair(
            "table-name", "sess-1", "user msg", "bot reply", dynamodb_resource=mock_resource
        )

        mock_resource.Table.assert_called_once_with("table-name")
        mock_table.update_item.assert_called_once_with(
            Key={"SessionId": "sess-1"},
            UpdateExpression="SET History = list_append(if_not_exists(History, :empty), :msgs)",
            ExpressionAttributeValues={
                ":msgs": [
                    {"role": "user", "content": "user msg"},
                    {"role": "assistant", "content": "bot reply"},
                ],
                ":empty": [],
            },
        )

    def test_does_not_raise_on_exception(self):
        mock_table = MagicMock()
        mock_table.update_item.side_effect = Exception("DynamoDB error")
        mock_resource = MagicMock()
        mock_resource.Table.return_value = mock_table

        # Should not raise
        persist_message_pair(
            "table-name", "sess-1", "user msg", "bot reply", dynamodb_resource=mock_resource
        )


class TestConstants:
    """Tests for module constants."""

    def test_max_prompt_turns_is_10(self):
        assert MAX_PROMPT_TURNS == 10

    def test_max_retrieval_turns_is_4(self):
        assert MAX_RETRIEVAL_TURNS == 4
