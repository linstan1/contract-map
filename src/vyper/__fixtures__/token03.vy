# @version 0.3.7
"""
A minimal 0.3-style token, used to exercise @external/@internal dispatch,
self.balanceOf writes reached through an internal helper, a public getter,
and an owner-gated admin setter.
"""

event Transfer:
    sender: indexed(address)
    receiver: indexed(address)
    value: uint256

balanceOf: public(HashMap[address, uint256])
totalSupply: public(uint256)
owner: address

@external
def __init__(_supply: uint256):
    self.totalSupply = _supply
    self.balanceOf[msg.sender] = _supply
    self.owner = msg.sender

@internal
def _move(_from: address, _to: address, _value: uint256):
    assert self.balanceOf[_from] >= _value, "insufficient balance"
    self.balanceOf[_from] -= _value
    self.balanceOf[_to] += _value
    log Transfer(_from, _to, _value)

@external
def transfer(_to: address, _value: uint256) -> bool:
    self._move(msg.sender, _to, _value)
    return True

@external
def set_owner(_new: address):
    assert msg.sender == self.owner, "not owner"
    self.owner = _new
