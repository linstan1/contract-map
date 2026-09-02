# pragma version 0.4.0
"""
A 0.4-style contract, used to exercise extcall/staticcall, a call through an
interface-typed state variable, a raw_call with a literal method_id, and a
raw_call with fully dynamic calldata.
"""

interface ERC20:
    def transfer(_to: address, _value: uint256) -> bool: nonpayable
    def balanceOf(_owner: address) -> uint256: view

token: public(address)
vault: ERC20
admin: address

@deploy
def __init__(_token: address):
    self.token = _token
    self.vault = ERC20(_token)
    self.admin = msg.sender

@external
def sweep(_to: address, _amount: uint256):
    assert msg.sender == self.admin
    extcall ERC20(self.token).transfer(_to, _amount)

@external
@view
def balance(_who: address) -> uint256:
    return staticcall ERC20(self.token).balanceOf(_who)

@external
def sweep_via_state(_to: address, _amount: uint256):
    assert msg.sender == self.admin
    extcall self.vault.transfer(_to, _amount)

@external
def raw_transfer(_target: address, _to: address, _amount: uint256):
    assert msg.sender == self.admin
    raw_call(_target, concat(method_id("transfer(address,uint256)"), convert(_to, bytes32), convert(_amount, bytes32)))

@external
def raw_dynamic(_target: address, _data: Bytes[256]):
    assert msg.sender == self.admin
    raw_call(_target, _data)
